import { randomUUID } from "node:crypto";

export type DoctorReport = {
  schemaVersion: "1";
  origin: string;
  profileId: string;
  checks: Array<{ key: string; status: "ok" | "failed"; detail: string }>;
  canaryThreadId?: string;
};

export async function runDoctor(input: {
  origin: string;
  profileId: string;
  gatewayBasePath?: string;
  writeCanary?: boolean;
  fetch?: typeof globalThis.fetch;
}): Promise<DoctorReport> {
  const origin = new URL(input.origin);
  if (origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("originにはschemeとhostだけを指定してください");
  }
  const base = input.gatewayBasePath ?? "/internal/feedback-redmine/v1";
  if (!base.startsWith("/") || base.startsWith("//")) throw new Error("gatewayBasePathが不正です");
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const checks: DoctorReport["checks"] = [];
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => fetchImplementation(
    new URL(`${base}${path}`, origin).toString(),
    { ...init, headers: { Origin: origin.origin, "Sec-Fetch-Site": "same-origin", ...init.headers } }
  );
  const ready = await request("/health/ready");
  checks.push(result("gateway-ready", ready));
  const profile = await request(`/profiles/${encodeURIComponent(input.profileId)}`);
  checks.push(result("profile", profile));
  const browserProfileId = randomUUID();
  const participant = await request(`/profiles/${encodeURIComponent(input.profileId)}/participants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browserProfileId })
  });
  checks.push(result("participant", participant, 201));
  if (!participant.ok) return { schemaVersion: "1", origin: origin.origin, profileId: input.profileId, checks };
  const issued = await participant.json() as { credential?: unknown };
  if (typeof issued.credential !== "string") throw new Error("participant credential responseが不正です");
  const me = await request(`/profiles/${encodeURIComponent(input.profileId)}/me`, {
    headers: { "X-Feedback-Participant-Credential": issued.credential }
  });
  checks.push(result("redmine-current-user", me));
  if (!input.writeCanary) return { schemaVersion: "1", origin: origin.origin, profileId: input.profileId, checks };

  const threadId = randomUUID();
  const intentId = randomUUID();
  const body = {
    resourceRef: { schemaVersion: "1", kind: "record", key: "feedback-redmine-doctor" },
    threadId,
    intentId,
    comment: "Feedback Redmine doctorによる明示的な疎通確認です。",
    perspectiveCode: "general",
    location: { schemaVersion: "1", pageKey: "feedback.doctor", routeTemplate: "/", pathParameters: {} },
    target: null,
    release: "feedback-redmine-ops",
    locale: "ja-JP",
    threadUrl: `${origin.origin}/?feedbackThread=${threadId}`,
    capturedAt: new Date().toISOString(),
    evidence: null,
    participantName: "Feedback Doctor"
  };
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(body)], { type: "application/json" }));
  const canary = await request(`/profiles/${encodeURIComponent(input.profileId)}/threads`, {
    method: "POST",
    headers: {
      "Idempotency-Key": intentId,
      "X-Feedback-Participant-Credential": issued.credential
    },
    body: form
  });
  checks.push(result("write-canary", canary, 201, [200]));
  return { schemaVersion: "1", origin: origin.origin, profileId: input.profileId, checks, canaryThreadId: threadId };
}

function result(key: string, response: Response, expected = 200, alternatives: number[] = []) {
  const ok = response.status === expected || alternatives.includes(response.status);
  return { key, status: ok ? "ok" as const : "failed" as const, detail: `HTTP ${response.status}` };
}
