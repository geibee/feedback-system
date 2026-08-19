import { RedmineFeedbackError, isRedmineErrorCode, type RedmineErrorCode } from "./errors.js";

export type RedmineDiagnosticEntryV1 = {
  requestId: string;
  operation: string;
  profileId: string;
  httpStatus: number | null;
  durationMilliseconds: number;
  errorCode: RedmineErrorCode | null;
};

export type RedmineDiagnosticDocumentV1 = {
  schemaVersion: "1";
  generatedAt: string;
  entries: RedmineDiagnosticEntryV1[];
};

export class RedmineDiagnosticBuffer {
  readonly #maximumEntries: number;
  readonly #entries: RedmineDiagnosticEntryV1[] = [];

  constructor(maximumEntries = 100) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 100) {
      throw new Error("diagnostic ring buffer上限が不正です");
    }
    this.#maximumEntries = maximumEntries;
  }

  record(entry: RedmineDiagnosticEntryV1): void {
    const validated = validateEntry(entry);
    this.#entries.push(validated);
    if (this.#entries.length > this.#maximumEntries) {
      this.#entries.splice(0, this.#entries.length - this.#maximumEntries);
    }
  }

  snapshot(): RedmineDiagnosticEntryV1[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  document(generatedAt = new Date().toISOString()): RedmineDiagnosticDocumentV1 {
    if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("diagnostic生成日時が不正です");
    return { schemaVersion: "1", generatedAt, entries: this.snapshot() };
  }

  clear(): void {
    this.#entries.length = 0;
  }
}

export function diagnosticErrorCode(error: unknown): RedmineErrorCode {
  return error instanceof RedmineFeedbackError ? error.code : "redmine.unavailable";
}

function validateEntry(entry: RedmineDiagnosticEntryV1): RedmineDiagnosticEntryV1 {
  if (!uuidPattern.test(entry.requestId)) throw new Error("diagnostic request IDが不正です");
  if (!operationPattern.test(entry.operation)) throw new Error("diagnostic operationが不正です");
  if (!profilePattern.test(entry.profileId)) throw new Error("diagnostic profile IDが不正です");
  if (entry.httpStatus !== null && (!Number.isSafeInteger(entry.httpStatus) || entry.httpStatus < 100 || entry.httpStatus > 599)) {
    throw new Error("diagnostic HTTP statusが不正です");
  }
  if (!Number.isFinite(entry.durationMilliseconds) || entry.durationMilliseconds < 0) {
    throw new Error("diagnostic durationが不正です");
  }
  if (entry.errorCode !== null && !isRedmineErrorCode(entry.errorCode)) throw new Error("diagnostic error codeが不正です");
  return {
    requestId: entry.requestId,
    operation: entry.operation,
    profileId: entry.profileId,
    httpStatus: entry.httpStatus,
    durationMilliseconds: Math.round(entry.durationMilliseconds * 100) / 100,
    errorCode: entry.errorCode
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const operationPattern = /^(?:redmine|profile)\.[a-z0-9.-]+\.v1$/u;
const profilePattern = /^[a-z0-9][a-z0-9._-]{0,99}$/u;
