import { describe, expect, it } from "vitest";
import type { GatewayHostPrincipal } from "@feedback/redmine-gateway";
import {
  createRejectingSessionAdapter,
  createSignedDemoSessionAdapter,
  signDemoSession,
  type SignedDemoSession
} from "./session-adapter.js";

const secret = "test-only-session-secret";
const session: SignedDemoSession = {
  schemaVersion: "1",
  subjectId: "host-user-1",
  displayName: "利用者",
  redmineUserId: null,
  profileId: "inventory-production",
  canCreate: true,
  resources: [{ schemaVersion: "1", kind: "record", key: "order-1", storedResourceKey: "opaque-order-1" }],
  csrfToken: "csrf-token",
  expiresAt: Math.floor(Date.now() / 1000) + 300
};

describe("signed demo session adapter", () => {
  it("署名済みcookieのprincipal・profile・resource・CSRFを検証する", async () => {
    const adapter = createSignedDemoSessionAdapter(secret);
    const token = signDemoSession(session, secret);
    const principal = await adapter.authenticate(new Request("https://app.example", {
      headers: { Cookie: `another=value; feedback_redmine_demo_session=${token}` }
    }));
    expect(principal).toMatchObject({ subjectId: "host-user-1", displayName: "利用者", redmineUserId: null });
    expect(await adapter.authorizeProfile({ principal: principal!, operation: "create", profileId: session.profileId })).toBe(true);
    expect(await adapter.authorizeResource({
      principal: principal!, operation: "create", profileId: session.profileId,
      resourceRef: { schemaVersion: "1", kind: "record", key: "order-1" }
    })).toEqual({ resourceKey: "opaque-order-1" });
    expect(await adapter.authorizeStoredResource({
      principal: principal!, operation: "attachment", profileId: session.profileId, storedResourceKey: "opaque-order-1"
    })).toBe(true);
    expect(await adapter.verifyCsrf({ request: new Request("https://app.example"), principal: principal!, token: "csrf-token" })).toBe(true);
  });

  it("改ざん・期限切れ・権限外resourceをfail-closedにする", async () => {
    const adapter = createSignedDemoSessionAdapter(secret);
    const valid = signDemoSession(session, secret);
    expect(await adapter.authenticate(requestWithCookie(`${valid}x`))).toBeNull();
    expect(await adapter.authenticate(requestWithCookie(signDemoSession({
      ...session,
      expiresAt: Math.floor(Date.now() / 1000) - 1
    }, secret)))).toBeNull();

    const principal = await adapter.authenticate(requestWithCookie(valid)) as GatewayHostPrincipal;
    expect(await adapter.authorizeResource({
      principal, operation: "list", profileId: session.profileId,
      resourceRef: { schemaVersion: "1", kind: "record", key: "order-2" }
    })).toBeNull();
    expect(await adapter.authorizeStoredResource({
      principal, operation: "detail", profileId: session.profileId, storedResourceKey: "opaque-order-2"
    })).toBe(false);
  });

  it("rejecting adapterは全operationを拒否する", async () => {
    const adapter = createRejectingSessionAdapter();
    expect(await adapter.authenticate(new Request("https://app.example"))).toBeNull();
    const principal = { subjectId: "x", displayName: null, redmineUserId: null };
    expect(await adapter.authorizeProfile({ principal, operation: "read", profileId: "p" })).toBe(false);
    expect(await adapter.verifyCsrf({ request: new Request("https://app.example"), principal, token: "x" })).toBe(false);
  });
});

function requestWithCookie(token: string): Request {
  return new Request("https://app.example", { headers: { Cookie: `feedback_redmine_demo_session=${token}` } });
}
