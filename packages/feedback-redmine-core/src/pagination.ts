import type { RedmineThreadFilter, RedmineThreadSort } from "./model.js";
import { contractError } from "./errors.js";
import { canonicalJson, utf8 } from "./context.js";

export type RedmineListCursorV1 = {
  v: "1";
  profileId: string;
  hostResourceKey: string;
  pageKey: string;
  filter: RedmineThreadFilter;
  sort: RedmineThreadSort;
  offset: number;
};

export type RedmineWorkspaceListCursorV2 = {
  v: "2";
  scope: "workspace";
  profileId: string;
  filter: RedmineThreadFilter;
  sort: RedmineThreadSort;
  offset: number;
};

export type RedmineListCursor = RedmineListCursorV1 | RedmineWorkspaceListCursorV2;

export function encodeListCursor(cursor: RedmineListCursor): string {
  validateCursor(cursor);
  const encoded = base64Encode(utf8(canonicalJson(cursor)))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
  if (encoded.length > 2048) throw contractError("cursorが2 KiBを超えています");
  return encoded;
}

export function decodeListCursor(encoded: string, expected: Omit<RedmineListCursorV1, "offset">): RedmineListCursorV1;
export function decodeListCursor(encoded: string, expected: Omit<RedmineWorkspaceListCursorV2, "offset">): RedmineWorkspaceListCursorV2;
export function decodeListCursor(
  encoded: string,
  expected: Omit<RedmineListCursorV1, "offset"> | Omit<RedmineWorkspaceListCursorV2, "offset">
): RedmineListCursor {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > 2048) throw contractError("cursor形式が不正です");
  let value: unknown;
  try {
    const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
    const bytes = base64Decode(`${encoded.replace(/-/gu, "+").replace(/_/gu, "/")}${padding}`);
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw contractError("cursorをdecodeできません");
  }
  validateCursor(value);
  const cursor = value as RedmineListCursor;
  if (canonicalJson({ ...cursor, offset: undefined }) !== canonicalJson(expected)) {
    throw contractError("cursorが現在のqueryへ束縛されていません");
  }
  return cursor;
}

function validateCursor(value: unknown): asserts value is RedmineListCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError("cursorはobjectである必要があります");
  const cursor = value as Record<string, unknown>;
  const allowed = cursor.v === "2"
    ? new Set(["v", "scope", "profileId", "filter", "sort", "offset"])
    : new Set(["v", "profileId", "hostResourceKey", "pageKey", "filter", "sort", "offset"]);
  if (Object.keys(cursor).some((key) => !allowed.has(key))) throw contractError("cursorにunknown propertyがあります");
  const commonInvalid =
    typeof cursor.profileId !== "string" ||
    !cursor.filter ||
    typeof cursor.filter !== "object" ||
    Array.isArray(cursor.filter) ||
    !["created_desc", "created_asc", "updated_desc"].includes(cursor.sort as string) ||
    !Number.isInteger(cursor.offset) ||
    (cursor.offset as number) < 0 ||
    (cursor.offset as number) > 10_000;
  const resourceInvalid = cursor.v === "1" &&
    (typeof cursor.hostResourceKey !== "string" || typeof cursor.pageKey !== "string");
  const workspaceInvalid = cursor.v === "2" && cursor.scope !== "workspace";
  if ((cursor.v !== "1" && cursor.v !== "2") || commonInvalid || resourceInvalid || workspaceInvalid) {
    throw contractError("cursor値が不正です");
  }
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;
    output += alphabet[(chunk >> 18) & 63];
    output += alphabet[(chunk >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[chunk & 63] : "=";
  }
  return output;
}

function base64Decode(value: string): Uint8Array {
  if (value.length % 4 !== 0) throw new Error("invalid base64");
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const chars = value.slice(index, index + 4);
    const values = Array.from(chars, (char) => (char === "=" ? 0 : alphabet.indexOf(char)));
    if (values.some((item) => item < 0)) throw new Error("invalid base64");
    const chunk = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    bytes.push((chunk >> 16) & 255);
    if (chars[2] !== "=") bytes.push((chunk >> 8) & 255);
    if (chars[3] !== "=") bytes.push(chunk & 255);
  }
  return new Uint8Array(bytes);
}
