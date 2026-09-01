import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const openapi = parse(readFileSync(new URL("../feedback-gateway.openapi.yaml", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, {
    parameters?: Array<{ $ref?: string }>;
    responses: Record<string, unknown>;
    "x-feedback-authorization-mode"?: string;
  }> >;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, { type: string; in?: string; name?: string; scheme?: string }>;
  };
};

function componentValidator(name: string) {
  const schemas = JSON.parse(JSON.stringify(openapi.components.schemas)
    .split("#/components/schemas/").join("#/$defs/")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `#/$defs/${name}`,
    $defs: schemas
  });
}

const ids = {
  intentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5002",
  threadId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5001",
  messageId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5010",
  revisionId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5012",
  attachmentId: "018f0f58-c3d1-7a2b-8a4f-4c09571e5030"
};
const requestHash = `sha256:${"1".repeat(64)}`;

describe("Feedback v2 OpenAPI freeze候補", () => {
  it.each([
    ["CreateThreadCommand", { intentId: ids.intentId, requestHash, threadId: ids.threadId, resource: { kind: "record", key: "order-001" }, title: "Phase 2", body: "本文" }],
    ["ReplyCommand", { intentId: ids.intentId, requestHash, messageId: ids.messageId, body: "返信" }],
    ["AppendRevisionCommand", { intentId: ids.intentId, requestHash, revisionId: ids.revisionId, expectedRevisionId: ids.messageId, body: "改訂" }],
    ["UploadAttachmentCommand", { intentId: ids.intentId, requestHash, attachmentId: ids.attachmentId, filename: "phase2.txt", contentType: "text/plain", sizeBytes: 3, contentHash: `sha256:${"2".repeat(64)}`, purpose: "evidence" }]
  ])("%sはstrict DTOである", (name, command) => {
    const validate = componentValidator(name);
    expect(validate(command), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...command, providerIssueId: "10042" })).toBe(false);
  });

  it("intent回収はthreadIdとresource scopeを必須にする", () => {
    const operation = openapi.paths["/profiles/{profileId}/workspaces/{workspaceId}/intents/{intentId}"]?.get;
    const refs = operation?.parameters?.map((parameter) => parameter.$ref) ?? [];
    expect(refs).toContain("#/components/parameters/ThreadIdQuery");
    expect(refs).toContain("#/components/parameters/ResourceKind");
    expect(refs).toContain("#/components/parameters/ResourceKey");
    expect(refs).toContain("#/components/parameters/RequestHash");
  });

  it("public-profile participant credentialの公開発行契約を固定する", () => {
    const operation = openapi.paths["/profiles/{profileId}/participants"]?.post;
    expect(operation).toBeDefined();
    expect(operation?.["x-feedback-authorization-mode"]).toBe("public-profile");
    expect(openapi.components.securitySchemes.ParticipantCredential).toMatchObject({
      type: "apiKey", in: "header", name: "X-Feedback-Participant-Credential"
    });
    expect(openapi.components.securitySchemes.SignedGrant).toMatchObject({ type: "http", scheme: "bearer" });
    const request = componentValidator("CreateParticipantRequest");
    const result = componentValidator("ParticipantCredentialResult");
    expect(request({ browserProfileId: ids.messageId }), JSON.stringify(request.errors)).toBe(true);
    expect(request({ browserProfileId: ids.messageId, authorizationMode: "public-profile" })).toBe(false);
    expect(result({ participantId: ids.threadId, credential: "v2." + "x".repeat(64) }), JSON.stringify(result.errors)).toBe(true);
  });

  it("すべてのunsafe operationはCSRF headerを必須にする", () => {
    const posts = Object.entries(openapi.paths)
      .flatMap(([path, operations]) => operations.post ? [[path, operations.post] as const] : []);
    expect(posts).toHaveLength(5);
    for (const [path, operation] of posts) {
      expect(operation.parameters?.map((parameter) => parameter.$ref), path)
        .toContain("#/components/parameters/Csrf");
    }
  });

  it("provider障害、timeout、media type、size超過のHTTP境界を固定する", () => {
    const upload = openapi.paths["/profiles/{profileId}/workspaces/{workspaceId}/threads/{threadId}/attachments"]?.post;
    expect(Object.keys(upload?.responses ?? {})).toEqual(expect.arrayContaining(["413", "415", "429", "502", "503", "504"]));
    const reply = openapi.paths["/profiles/{profileId}/workspaces/{workspaceId}/threads/{threadId}/messages"]?.post;
    expect(Object.keys(reply?.responses ?? {})).toEqual(expect.arrayContaining(["409", "429", "502", "503", "504"]));
  });

  it("pendingとrepair_requiredは自動writeを許可しない", () => {
    const pending = componentValidator("IntentPendingResult");
    expect(pending({ intentId: ids.intentId, state: "pending", operation: "feedback:create", retryAfterSeconds: 2, automaticWriteAllowed: false })).toBe(true);
    expect(pending({ intentId: ids.intentId, state: "pending", operation: "feedback:create", retryAfterSeconds: 2, automaticWriteAllowed: true })).toBe(false);
    const repair = componentValidator("IntentRepairRequiredResult");
    expect(repair({ intentId: ids.intentId, state: "repair_required", operation: "feedback:attachment:upload", detail: "結果不明", automaticWriteAllowed: false, retryDirective: "manual-confirmation" })).toBe(true);
  });
});
