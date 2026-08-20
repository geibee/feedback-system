import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function validator(name: string) {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8"));
  return ajv.compile(schema);
}

describe("Feedback JSON Schema", () => {
  it("installation manifestは複数workspaceと初回access前のmembershipを検証する", () => {
    const validate = validator("installation-manifest");
    const entry = {
      tenantKey: "company",
      tenantDisplayName: "Company",
      applicationKey: "portal",
      applicationDisplayName: "Portal",
      environmentKey: "production",
      environmentBaseUrl: "https://portal.example.test",
      allowedOrigins: ["https://portal.example.test"],
      externalWorkspaceKey: "default",
      workspaceDisplayName: "Default",
      issuer: "https://id.example.test",
      subject: "owner",
      permissions: ["feedback.read", "feedback.admin"]
    };
    expect(validate({ schemaVersion: "1", entries: [entry] }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      schemaVersion: "1",
      entries: [{ ...entry, applicationKey: "Invalid Key" }]
    })).toBe(false);
    expect(validate({
      schemaVersion: "1",
      entries: [{ ...entry, issuer: "https://user@id.example.test" }]
    })).toBe(false);
    expect(validate({
      schemaVersion: "1",
      entries: [{ ...entry, allowedOrigins: ["http://portal.example.test"] }]
    })).toBe(false);
    expect(validate({ schemaVersion: "1", entries: [{ ...entry, secret: "value" }] })).toBe(false);
  });

  it("application manifestのrouteとparameter policyを検証する", () => {
    const validate = validator("application-manifest");
    expect(validate({
      schemaVersion: "1",
      applicationKey: "sample-app",
      displayName: "サンプル",
      manifestVersion: "1",
      routes: [{
        pageKey: "orders.detail",
        template: "/orders/{orderId}",
        label: "注文詳細",
        parameters: { orderId: { persistence: "hash" } }
      }]
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      schemaVersion: "1",
      applicationKey: "Invalid Key",
      displayName: "サンプル",
      manifestVersion: "1",
      routes: []
    })).toBe(false);
  });

  it("locationは生URLではなくmanifestで復元可能な構造だけを受ける", () => {
    const validate = validator("location");
    expect(validate({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}",
      pathParameters: { orderId: "A-1" },
      queryParameters: { tab: "history" }
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{orderId}?token=secret",
      pathParameters: { orderId: "A-1" }
    })).toBe(false);
  });

  it("targetの全variantと座標範囲を検証する", () => {
    const validate = validator("target");
    const targets = [
      { schemaVersion: "1", kind: "ui-element", elementKey: "save", relativeX: 0.5, relativeY: 0.5 },
      { schemaVersion: "1", kind: "screen-position", relativeX: 0, relativeY: 1 },
      {
        schemaVersion: "1",
        kind: "map-feature",
        provider: "maplibre",
        sourceKey: "parcels",
        featureKey: "P-1",
        longitude: 139.7,
        latitude: 35.6
      },
      { schemaVersion: "1", kind: "map-position", longitude: 139.7, latitude: 35.6 }
    ];
    for (const target of targets) expect(validate(target), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ schemaVersion: "1", kind: "map-position", longitude: 181, latitude: 0 })).toBe(false);
    expect(validate({ ...targets[0], unknown: true })).toBe(false);
  });

  it("webhookはversioned domain eventとactorを必須にする", () => {
    const validate = validator("webhook-event");
    const event = {
      schemaVersion: "1",
      eventId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-0001",
      eventType: "feedback.thread.created.v1",
      occurredAt: "2026-08-09T00:00:00Z",
      tenantKey: "tenant-1",
      applicationKey: "sample-app",
      environmentKey: "production",
      externalWorkspaceKey: "workspace-1",
      sessionId: "00000000-0000-4000-8000-000000000002",
      threadId: "00000000-0000-4000-8000-000000000003",
      actor: { principalId: "issuer|subject" },
      deepLink: "https://app.example/orders/1?feedbackThread=1",
      evidenceUrl: "/feedback/v1/threads/00000000-0000-4000-8000-000000000003/evidence"
    };
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...event, eventType: "feedback.unknown.v1" })).toBe(false);
  });

  it("connector protocolはmanifest・delivery・resultと互換versionを固定する", () => {
    const localAjv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(localAjv);
    const eventSchema = JSON.parse(readFileSync(new URL("../schemas/webhook-event.schema.json", import.meta.url), "utf8"));
    localAjv.addSchema(eventSchema, "https://feedback.example/schemas/webhook-event.schema.json");
    const connectorSchema = JSON.parse(readFileSync(new URL("../schemas/connector-protocol.schema.json", import.meta.url), "utf8"));
    const validate = localAjv.compile(connectorSchema);
    const event = {
      schemaVersion: "1",
      eventId: "00000000-0000-4000-8000-000000000001",
      requestId: "request-1",
      eventType: "feedback.message.created.v1",
      occurredAt: "2026-08-09T00:00:00Z",
      tenantKey: "tenant-1",
      applicationKey: "sample-app",
      environmentKey: "production",
      externalWorkspaceKey: "workspace-1",
      sessionId: "00000000-0000-4000-8000-000000000002",
      threadId: "00000000-0000-4000-8000-000000000003",
      actor: { principalId: "issuer|subject" },
      deepLink: "https://app.example/review?feedbackThread=1"
    };
    expect(validate({
      kind: "manifest",
      protocolVersion: "1",
      compatibleProtocolVersions: ["1"],
      connectorKey: "teams",
      displayName: "Teams",
      supportedEvents: ["feedback.message.created.v1"],
      healthPath: "/health/ready"
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      kind: "delivery-request",
      protocolVersion: "1",
      deliveryId: "00000000-0000-4000-8000-000000000004",
      eventId: event.eventId,
      destinationRef: "review-channel",
      occurredAt: event.occurredAt,
      event
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      kind: "delivery-request",
      protocolVersion: "1",
      deliveryId: "00000000-0000-4000-8000-000000000004",
      eventId: event.eventId,
      destinationRef: "review-channel",
      occurredAt: event.occurredAt,
      event: { ...event, evidenceUrl: "/feedback/v1/evidence" }
    })).toBe(false);
    expect(validate({
      kind: "delivery-result",
      protocolVersion: "1",
      deliveryId: "00000000-0000-4000-8000-000000000004",
      status: "accepted",
      receivedAt: "2026-08-09T00:00:01Z"
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      kind: "delivery-request",
      protocolVersion: "2",
      deliveryId: "00000000-0000-4000-8000-000000000004",
      destinationRef: "review-channel",
      event
    })).toBe(false);
  });

  it("token exchange JWTはactorとFeedback scope claimを必須にする", () => {
    const validate = validator("token-exchange-jwt");
    const claims = {
      iss: "https://broker.example",
      sub: "user-1",
      aud: "feedback-service",
      iat: 1000,
      exp: 1300,
      jti: "00000000-0000-4000-8000-000000000001",
      actor_issuer: "https://id.example",
      actor_sub: "user-1",
      feedback_tenant: "tenant-1",
      feedback_application: "inventory",
      feedback_environment: "production",
      feedback_workspace: "east",
      feedback_permissions: ["feedback.read", "feedback.comment"]
    };
    expect(validate(claims), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...claims, feedback_permissions: ["host.admin"] })).toBe(false);
    const { actor_sub: _actorSubject, ...withoutActor } = claims;
    expect(validate(withoutActor)).toBe(false);
  });
});

function redmineValidator(name: string) {
  const localAjv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(localAjv);
  const schemas = [
    "location",
    "target",
    "redmine-host-resource-ref",
    "redmine-client-profile",
    "redmine-model",
    "redmine-feedback-context"
  ];
  for (const dependency of schemas) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${dependency}.schema.json`, import.meta.url), "utf8"));
    localAjv.addSchema(schema);
  }
  const validate = localAjv.getSchema(`https://feedback.example/schemas/${name}.v1.json`);
  if (!validate) throw new Error(`${name}のvalidatorを作成できません`);
  return validate;
}

const clientProfile = {
  schemaVersion: "1",
  id: "inventory-production",
  displayName: "Inventory / Production",
  applicationKey: "inventory",
  environmentKey: "production",
  externalWorkspaceKey: "production-review",
  perspectives: [{ code: "ux", label: "UI/UX" }],
  capture: {
    enabled: true,
    maximumUploadBytes: 10485760,
    contentTypes: ["image/png", "image/webp"]
  },
  attachments: {
    maximumInlinePreviewBytes: 10485760,
    maximumDownloadBytes: 52428800
  }
};

describe("Feedback Redmine JSON Schema", () => {
  it("runtime configは公開可能な同一origin設定だけを受ける", () => {
    const validate = validator("redmine-runtime-config");
    expect(validate({
      schemaVersion: "1",
      enabled: true,
      profileId: "inventory-production",
      gatewayBasePath: "/internal/feedback-redmine/v1"
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      schemaVersion: "1",
      enabled: true,
      profileId: "inventory-production",
      gatewayBasePath: "https://gateway.example.test/v1"
    })).toBe(false);
    for (const gatewayBasePath of [
      "//gateway.example.test/v1",
      "/internal/../gateway",
      "/internal/%2e%2E/gateway",
      "/internal/gateway?token=value",
      "/internal/gateway#fragment",
      "/internal/gateway@evil",
      "/internal\\gateway",
      `/${"a".repeat(512)}`
    ]) {
      expect(validate({
        schemaVersion: "1",
        enabled: true,
        profileId: "inventory-production",
        gatewayBasePath
      }), gatewayBasePath).toBe(false);
    }
    expect(validate({
      schemaVersion: "1",
      enabled: true,
      profileId: "inventory-production",
      gatewayBasePath: "/internal/feedback-redmine/v1",
      apiKey: "secret"
    })).toBe(false);
  });

  it("既存Redmine導入manifestは名前ベースでsecretと数値IDを持たない", () => {
    const validate = validator("redmine-installation-manifest");
    const manifest = {
      schemaVersion: "1",
      profileId: "inventory-production",
      displayName: "Inventory / Production",
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      redmineBaseUrl: "https://redmine.example.test",
      project: { identifier: "feedback", name: "Feedback" },
      trackerName: "Feedback",
      openStatusName: "New",
      closedStatusName: "Closed",
      defaultPriorityName: "Normal",
      roleName: "Feedback integration",
      integrationUser: {
        login: "feedback_integration",
        firstName: "Feedback",
        lastName: "Integration",
        mail: "feedback-integration@example.test"
      },
      isPrivate: true,
      captureEnabled: true,
      showRedmineLink: false
    };
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest, projectId: 10 })).toBe(false);
    expect(validate({ ...manifest, apiKey: "secret" })).toBe(false);
  });

  it("provision planとresultはdigestおよび実IDを固定shapeで検証する", () => {
    const validatePlan = validator("redmine-provision-plan");
    expect(validatePlan({
      schemaVersion: "1",
      redmineVersion: "7.0.0",
      profileId: "inventory-production",
      operations: [{ key: "project", action: "create", detail: "projectを作成" }],
      conflicts: [],
      planDigest: "a".repeat(64)
    }), JSON.stringify(validatePlan.errors)).toBe(true);
    const ids = Object.fromEntries([
      "threadId", "requestHash", "applicationKey", "environmentKey", "externalWorkspaceKey", "pageKey",
      "hostResourceKey", "perspectiveCode", "locator", "submittedById", "submittedByName"
    ].map((key, index) => [key, index + 20]));
    const validateResult = validator("redmine-provision-result");
    const result = {
      schemaVersion: "1",
      redmineVersion: "7.0.0",
      projectId: 1,
      trackerId: 2,
      openStatusId: 3,
      closedStatusId: 4,
      defaultPriorityId: 5,
      integrationUserId: 6,
      customFieldIds: ids
    };
    expect(validateResult(result), JSON.stringify(validateResult.errors)).toBe(true);
    expect(validateResult({ ...result, customFieldIds: { ...ids, apiKey: 99 } })).toBe(false);
  });

  it("公開client profileへsecretや接続先を混入できない", () => {
    const validate = redmineValidator("redmine-client-profile");
    expect(validate(clientProfile), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...clientProfile, apiKey: "secret" })).toBe(false);
    expect(validate({ ...clientProfile, redmineBaseUrl: "https://redmine.example.invalid" })).toBe(false);
    expect(validate({ ...clientProfile, gatewayBasePath: "https://gateway.example.invalid" })).toBe(false);
    expect(validate({ ...clientProfile, id: "Invalid Profile" })).toBe(false);
  });

  it("context attachmentは再構築情報を固定shapeで検証する", () => {
    const validate = redmineValidator("redmine-feedback-context");
    const context = {
      schemaVersion: "1",
      kind: "feedback-context",
      threadId: "00000000-0000-4000-8000-000000000001",
      intentId: "00000000-0000-4000-8000-000000000002",
      requestHash: "a".repeat(64),
      applicationKey: "inventory",
      environmentKey: "production",
      externalWorkspaceKey: "production-review",
      pageKey: "orders.detail",
      hostResourceKey: "opaque-resource-key",
      release: "2026.08.19",
      locale: "ja-JP",
      perspectiveCode: "ux",
      location: {
        schemaVersion: "1",
        pageKey: "orders.detail",
        routeTemplate: "/orders/{orderId}",
        pathParameters: { orderId: "sha256:value" },
        queryParameters: {}
      },
      target: {
        schemaVersion: "1",
        kind: "ui-element",
        elementKey: "approve-button",
        relativeX: 0.5,
        relativeY: 0.5
      },
      author: {
        source: "participant-credential",
        participantId: "00000000-0000-4000-8000-000000000007",
        displayName: "利用者"
      },
      capturedAt: "2026-08-19T00:00:00Z",
      primaryEvidence: null
    };
    expect(validate(context), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...context, cookie: "session" })).toBe(false);
    expect(validate({ ...context, requestHash: "ABC" })).toBe(false);
    expect(validate({
      ...context,
      author: { ...context.author, source: "unsupported", subjectId: "host-user" }
    })).toBe(false);
  });

  it("gateway OpenAPIは9つの共通operationを重複なく公開する", () => {
    const source = readFileSync(new URL("../redmine-gateway.openapi.yaml", import.meta.url), "utf8");
    const operations = [...source.matchAll(/x-feedback-operation: ([^\n]+)/g)].map((match) => match[1]);
    expect(operations).toEqual([
      "redmine.participant.create.v1",
      "redmine.profile.get.v1",
      "redmine.current-user.get.v1",
      "redmine.thread.list.v1",
      "redmine.thread.create.v1",
      "redmine.thread.get.v1",
      "redmine.message.create.v1",
      "redmine.message.update.v1",
      "redmine.attachment.get.v1"
    ]);
    expect(new Set(operations).size).toBe(9);
  });
});
