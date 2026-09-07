// live runner共通。providerへの通信だけを呼出し元へ委譲し、公開HTTP契約を実Serviceで検証する。
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createFeedbackHttpClient, createFetchFeedbackTransport } from "@geibee/feedback-client";
import { calculateFeedbackCommandHash } from "@geibee/feedback-envelope";
import { createFeedbackService } from "@geibee/feedback-service";
import { createProductionFeedbackProjectionVerifier } from "@geibee/feedback-service-runtime";

export async function runFeedbackReferenceAcceptance(input) {
  const { scope, codec, runtimeProfile, createRepository } = input;
  const origin = "https://feedback-acceptance.invalid";
  const capability = await createRepository(randomUUID()).getCapabilities();
  const operations = [...capability.backendOperations];
  const ring = (kid, key = randomBytes(32)) => JSON.stringify({ activeKid: kid, keys: [{ kid, key: Buffer.from(key).toString("base64url") }] });
  // この試験専用の鍵。配備用secretへのdefaultや、provider dataの永続化ではない。
  const secrets = {
    PROVIDER: input.providerCredential,
    ENVELOPE: ring(input.envelopeKid, input.envelopeSecret),
    PARTICIPANT: ring("participant"),
    DERIVATION: randomBytes(32).toString("base64url"),
    REFERENCE: ring("reference")
  };
  const profile = {
    schemaVersion: "2", profileId: scope.profileId, installationId: scope.installationId,
    displayName: "参照live acceptance", connectorKey: runtimeProfile.connectorKey,
    connectorProfileRef: runtimeProfile.id,
    workspacePolicy: { workspaceIds: [scope.workspaceId], workspaceDiscovery: "unsupported", resourceDiscovery: "unsupported" },
    authorization: { mode: "public-profile" },
    policy: { operations, resourceKinds: [scope.resource.kind] },
    capabilities: {
      operations, discovery: { workspaces: "unsupported", resources: "unsupported" },
      operationGuarantees: capability.operationGuarantees, creationFields: [],
      maximumMetadataBytes: 32768, projectionValidation: "envelope-required", uniqueThreadLookup: false
    },
    secretRefs: Object.fromEntries(Object.entries({ providerCredential: "PROVIDER", envelopeKeyRing: "ENVELOPE",
      participantCredentialKeyRing: "PARTICIPANT", participantIdDerivationKey: "DERIVATION", threadReferenceKeyRing: "REFERENCE" })
      .map(([key, id]) => [key, { kind: "server-secret", id }]))
  };
  let denyRead = false;
  let directOnly = false;
  let repositoryCalls = 0;
  const newService = () => createFeedbackService({
    configuration: {
      settings: { schemaVersion: "2", serviceId: "reference-live", profileFiles: ["/acceptance/profile.json"],
        signedGrantIssuers: [], remoteAuthorizationProfiles: [],
        jwksCache: { maximumIssuers: 1, maximumKeysPerIssuer: 1, maximumTtlSeconds: 1 } },
      profileLoader: { async loadProfiles() { return [{ ...profile, policy: { ...profile.policy,
        operations: denyRead ? operations.filter((op) => op !== "feedback:read") : operations } }]; } },
      secretResolver: { async resolve(id) { assert.ok(Object.hasOwn(secrets, id)); return secrets[id]; } }
    },
    connectors: new Map(), expectedOrigin: origin, maximumRequestBytes: 1048576, operationTimeoutMilliseconds: 60000,
    projectionVerifier: createProductionFeedbackProjectionVerifier({
      catalog: { schemaVersion: "1", profiles: new Map([[runtimeProfile.id, runtimeProfile]]) },
      async loadCodec() { return codec; }
    }),
    repositoryResolver({ participantPrincipal }) {
      assert.ok(participantPrincipal, "公開credential経路がConnectorへ到達しません");
      const repository = createRepository(participantPrincipal.participantId);
      const find = repository.findThreadCandidatesById.bind(repository);
      repository.findThreadCandidatesById = (query, options) => {
        repositoryCalls++;
        assert.ok(!directOnly || options?.threadRef, "固定参照から検索へfallbackしました");
        return find(query, options);
      };
      return repository;
    }
  });
  let service = newService();
  let credential;
  const client = createFeedbackHttpClient({
    credentialProvider: () => credential ? { participantCredential: credential } : undefined,
    transport: createFetchFeedbackTransport(async (path, init) => {
      const headers = new Headers(init.headers);
      if (init.method === "POST") headers.set("Origin", origin);
      return service.handle(new Request(`${origin}${path}`, { ...init, headers }));
    })
  });
  const participant = await client.issueParticipant({ profileId: scope.profileId, browserProfileId: randomUUID() });
  credential = participant.credential;
  const query = { profileId: scope.profileId, workspaceId: scope.workspaceId, resource: scope.resource, threadId: randomUUID() };
  const command = (value) => ({ ...value, intentId: randomUUID(), requestHash: calculateFeedbackCommandHash(value) });
  const create = command({ threadId: query.threadId, resource: scope.resource, title: input.title, body: "参照経路の初期本文" });
  const created = await client.createThread({ profileId: query.profileId, workspaceId: query.workspaceId, command: create });
  assert.ok("thread" in created && created.threadReference, "create応答に固定参照がありません");
  const options = { threadReference: created.threadReference };
  directOnly = true;
  if (input.createDuplicate) await input.createDuplicate({ ...scope, command: {
    ...create, intentId: randomUUID(), requestHash: calculateFeedbackCommandHash({ duplicate: query.threadId }),
    body: "別issue。固定参照の操作対象ではない"
  } });
  // 同一のreadonly設定とsecretだけでServiceを再構成する。参照mapは渡さない。
  service = newService();
  const read = await client.getThread(query, options);
  assert.equal(read.messages[0]?.body, create.body);
  const reply = command({ messageId: randomUUID(), body: "参照経路の返信" });
  const replied = await client.reply({ ...query, command: reply }, options);
  assert.ok("message" in replied && replied.message.messageId === reply.messageId);
  const revision = command({ revisionId: randomUUID(), expectedRevisionId: reply.messageId, body: "参照経路の改訂" });
  const revised = await client.appendRevision({ ...query, messageId: reply.messageId, command: revision }, options);
  assert.ok("message" in revised && revised.message.body === revision.body);
  for (const [operation, value] of [["feedback:create", create], ["feedback:reply", reply], ["feedback:revise", revision]]) {
    const recovered = await client.recoverIntent({ ...query, operation, intentId: value.intentId, requestHash: value.requestHash }, options);
    assert.equal(recovered.state, "completed");
  }
  let attachment = "unsupported";
  if (operations.includes("feedback:attachment:upload")) {
    const bytes = new TextEncoder().encode("参照付き添付\n");
    const { createHash } = await import("node:crypto");
    const upload = command({ attachmentId: randomUUID(), messageId: reply.messageId, filename: "reference.txt",
      contentType: "text/plain", sizeBytes: bytes.byteLength,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, purpose: "evidence" });
    const result = await client.uploadAttachment({ ...query, command: upload,
      source: { sizeBytes: bytes.byteLength, async *stream() { yield bytes; } } }, options);
    assert.ok("attachment" in result);
    const download = await client.getAttachment({ ...query, attachmentId: upload.attachmentId }, options);
    const chunks = [];
    for await (const chunk of download.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
    attachment = "verified";
  }
  const reread = await client.getThread(query, options);
  assert.equal(reread.messages.find((message) => message.messageId === reply.messageId)?.body, revision.body);
  if (input.verifyDuplicate) await input.verifyDuplicate(query.threadId);
  const token = options.threadReference.split(".");
  const ciphertext = Buffer.from(token[3], "base64url");
  ciphertext[0] ^= 1;
  token[3] = ciphertext.toString("base64url");
  await assert.rejects(() => client.getThread(query, { threadReference: token.join(".") }),
    (error) => error.problem?.status === 409);
  await assert.rejects(() => client.getThread({ ...query, resource: { ...scope.resource, key: `${scope.resource.key}-wrong` } }, options),
    (error) => error.problem?.status === 409);
  denyRead = true;
  const calls = repositoryCalls;
  await assert.rejects(() => client.getThread(query, options), (error) => error.problem?.status === 403);
  assert.equal(repositoryCalls, calls, "現在の認可取消後にproviderへアクセスしました");
  return { publicCredential: true, create: true, read: true, reply: true, revision: true, recovery: true,
    serviceReconstruction: true, noSearchFallback: true, tamperRejected: true, scopeRejected: true,
    currentAuthorization: true, duplicateTargetIsolated: Boolean(input.verifyDuplicate), attachment };
}
