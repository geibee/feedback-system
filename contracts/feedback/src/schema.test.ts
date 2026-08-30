import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function validator(name: string) {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8"));
  const existing = typeof schema.$id === "string" ? ajv.getSchema(schema.$id) : undefined;
  if (existing) return existing;
  return ajv.compile(schema);
}

describe("Feedback Redmine共通JSON Schema", () => {
  it("locationは生URLではなく復元可能な構造だけを受ける", () => {
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

  it("custom targetはDOM追従metadataを既存契約のまま保持できる", () => {
    const validate = validator("target");
    const custom = {
      schemaVersion: "1",
      kind: "custom",
      provider: "io.github.geibee.feedback.dom",
      targetKey: "document",
      fallbackRelativeX: 0.25,
      fallbackRelativeY: 0.75,
      metadata: { coordinateSpace: "document", documentX: 100, documentY: 200 }
    };
    expect(validate(custom), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...custom, fallbackTarget: custom })).toBe(false);
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
    "redmine-runtime-config",
    "redmine-model",
    "redmine-feedback-context",
    "redmine-inspection-report"
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
      gatewayBasePath: "/internal/feedback-redmine/v1",
      submissionNotice: {
        message: "動画はSharePointへ配置してURLを共有してください。",
        link: { url: "https://sharepoint.example.test/feedback", label: "配置先を開く" }
      }
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
    expect(validate({
      ...manifest,
      perspectives: [{ code: "security", label: "セキュリティ" }, { code: "ux", label: "UI/UX" }]
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest, perspectives: [] })).toBe(false);
    expect(validate({ ...manifest, perspectives: [{ code: "ux", label: "UI" }, { code: "ux", label: "UI" }] })).toBe(false);
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

  it("inspection reportはREST検査、15件の手動確認、承認済み生成物を検証する", () => {
    const validate = redmineValidator("redmine-inspection-report");
    const customFieldKeys = [
      "threadId", "requestHash", "applicationKey", "environmentKey", "externalWorkspaceKey", "pageKey",
      "hostResourceKey", "perspectiveCode", "locator", "submittedById", "submittedByName"
    ];
    const customFieldIds = Object.fromEntries(customFieldKeys.map((key, index) => [key, index + 20]));
    const manualChecks = [
      ...customFieldKeys.map((key) => ({
        key: `custom-field.${key}.scope-and-filter`,
        detail: `${key}の公開範囲とfilterを確認する`,
        status: "accepted" as const
      })),
      ...["open-to-open", "open-to-closed", "closed-to-open", "closed-to-closed"].map((transition) => ({
        key: `workflow.${transition}`,
        detail: `${transition}の遷移を確認する`,
        status: "accepted" as const
      }))
    ];
    const report = {
      schemaVersion: "1",
      redmineVersion: "7.0.0",
      principal: { id: 1, login: "redmine_admin", admin: true },
      checks: [{ key: "project", status: "ok", detail: "Feedback projectを検出しました" }],
      manualChecks,
      manualCheckDigest: "a".repeat(64),
      resolvedIds: {
        projectId: 1,
        trackerId: 2,
        roleId: 3,
        integrationUserId: 4,
        defaultPriorityId: 5,
        openStatusId: 6,
        closedStatusIds: [7],
        customFieldIds
      },
      generated: {
        clientProfile: { ...clientProfile, showRedmineLink: false },
        serverProfile: {
          profileId: "inventory-production",
          clientProfileRef: "client-profile.json",
          redmineBaseUrl: "https://redmine.example.test",
          projectId: 1,
          trackerId: 2,
          isPrivate: true,
          defaultPriorityId: 5,
          closedStatusIds: [7],
          customFieldIds,
          authorizationMode: "resource-scoped",
          showRedmineLink: false,
          secretRef: "FEEDBACK_REDMINE_GATEWAY_API_KEY"
        },
        runtimeConfig: {
          schemaVersion: "1",
          enabled: true,
          profileId: "inventory-production",
          gatewayBasePath: "/internal/feedback-redmine/v1"
        }
      }
    };
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      ...report,
      manualChecks: manualChecks.map((check) => ({ ...check, status: "unverified" })),
      generated: null
    }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      ...report,
      manualChecks: manualChecks.map((check) => ({ ...check, status: "unverified" }))
    })).toBe(false);
    expect(validate({
      ...report,
      checks: [{ key: "project", status: "missing", detail: "projectがありません" }]
    })).toBe(false);
    expect(validate({ ...report, checks: [] })).toBe(false);
    expect(validate({ ...report, manualChecks: manualChecks.slice(0, 14) })).toBe(false);
    expect(validate({ ...report, manualCheckDigest: "A".repeat(64) })).toBe(false);
    expect(validate({ ...report, resolvedIds: { ...report.resolvedIds, openStatusId: 0 } })).toBe(false);
    expect(validate({ ...report, resolvedIds: { ...report.resolvedIds, defaultPriorityId: null } })).toBe(false);
    expect(validate({
      ...report,
      generated: {
        ...report.generated,
        clientProfile: { ...report.generated.clientProfile, apiKey: "secret" }
      }
    })).toBe(false);
    expect(validate({
      ...report,
      generated: {
        ...report.generated,
        serverProfile: { ...report.generated.serverProfile, apiKey: "secret" }
      }
    })).toBe(false);
    expect(validate({
      ...report,
      generated: {
        ...report.generated,
        runtimeConfig: { ...report.generated.runtimeConfig, participantSigningKey: "secret" }
      }
    })).toBe(false);
  });

  it("inspection reportの全階層でcredential fieldを拒否する", () => {
    const validate = redmineValidator("redmine-inspection-report");
    const manualChecks = Array.from({ length: 15 }, (_, index) => ({
      key: `manual.check-${index}`,
      detail: `手動確認${index}`,
      status: "unverified"
    }));
    const report = {
      schemaVersion: "1",
      redmineVersion: null,
      principal: null,
      checks: [{ key: "project", status: "missing", detail: "projectがありません" }],
      manualChecks,
      manualCheckDigest: "b".repeat(64),
      resolvedIds: {
        projectId: null,
        trackerId: null,
        roleId: null,
        integrationUserId: null,
        defaultPriorityId: null,
        openStatusId: null,
        closedStatusIds: [],
        customFieldIds: {}
      },
      generated: null
    };
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...report, apiKey: "secret" })).toBe(false);
    expect(validate({ ...report, principal: { id: 1, login: "admin", admin: true, password: "secret" } })).toBe(false);
    expect(validate({
      ...report,
      manualChecks: [{ ...manualChecks[0], apiKey: "secret" }, ...manualChecks.slice(1)]
    })).toBe(false);
    expect(validate({
      ...report,
      resolvedIds: { ...report.resolvedIds, customFieldIds: { apiKey: 99 } }
    })).toBe(false);
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

  it("gateway OpenAPIは10個の共通operationを重複なく公開する", () => {
    const source = readFileSync(new URL("../redmine-gateway.openapi.yaml", import.meta.url), "utf8");
    const operations = [...source.matchAll(/x-feedback-operation: ([^\n]+)/g)].map((match) => match[1]);
    expect(operations).toEqual([
      "redmine.participant.create.v1",
      "redmine.profile.get.v1",
      "redmine.creation-options.get.v1",
      "redmine.current-user.get.v1",
      "redmine.thread.list.v1",
      "redmine.thread.create.v1",
      "redmine.thread.get.v1",
      "redmine.message.create.v1",
      "redmine.message.update.v1",
      "redmine.attachment.get.v1"
    ]);
    expect(new Set(operations).size).toBe(10);
  });
});
