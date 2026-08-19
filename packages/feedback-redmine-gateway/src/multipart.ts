import { GatewayHttpError } from "./problem.js";

export type ParsedMultipart = {
  request: unknown;
  evidence: { bytes: Uint8Array; filename: string; contentType: "image/png" | "image/webp" } | null;
};

export async function readCreateMultipart(request: Request, maximumBytes: number): Promise<ParsedMultipart> {
  const contentType = request.headers.get("Content-Type") ?? "";
  const boundary = /boundary=(?:"([A-Za-z0-9'()+_,\-./:=?]{1,70})"|([A-Za-z0-9'()+_,\-./:=?]{1,70}))/u.exec(contentType)?.slice(1).find(Boolean);
  if (!contentType.toLowerCase().startsWith("multipart/form-data;") || !boundary) {
    throw new GatewayHttpError(400, "redmine.contract_invalid", "multipart/form-data boundaryがありません");
  }
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new GatewayHttpError(413, "redmine.payload_too_large", "request bodyが上限を超えています");
  }
  if (!request.body) throw new GatewayHttpError(400, "redmine.contract_invalid", "request bodyがありません");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new GatewayHttpError(413, "redmine.payload_too_large", "request bodyが上限を超えています");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
  return parseMultipartBytes(bytes, boundary);
}

function parseMultipartBytes(bytes: Uint8Array, boundary: string): ParsedMultipart {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 8192)));
  }
  const delimiter = `--${boundary}`;
  if (!binary.startsWith(`${delimiter}\r\n`) || !binary.endsWith(`${delimiter}--\r\n`)) {
    throw new GatewayHttpError(400, "redmine.contract_invalid", "multipart framingが不正です");
  }
  const rawParts = binary.slice(delimiter.length + 2, -(delimiter.length + 4)).split(`\r\n${delimiter}\r\n`);
  if (rawParts.length < 1 || rawParts.length > 2) {
    throw new GatewayHttpError(400, "redmine.contract_invalid", "multipart part数が不正です");
  }
  let requestPart: unknown;
  let evidence: ParsedMultipart["evidence"] = null;
  let searchOffset = delimiter.length + 2;
  for (const rawPart of rawParts) {
    const separator = rawPart.indexOf("\r\n\r\n");
    if (separator < 0 || !rawPart.endsWith("\r\n")) {
      throw new GatewayHttpError(400, "redmine.contract_invalid", "multipart partが不正です");
    }
    const headers = parseHeaders(rawPart.slice(0, separator));
    const rawIndex = binary.indexOf(rawPart, searchOffset);
    if (rawIndex < 0) throw new GatewayHttpError(400, "redmine.contract_invalid", "multipart part位置が不正です");
    searchOffset = rawIndex + rawPart.length;
    const bodyStart = rawIndex + separator + 4;
    const bodyLength = rawPart.length - separator - 6;
    const disposition = headers.get("content-disposition") ?? "";
    const name = /(?:^|;)\s*name="([^"]+)"/u.exec(disposition)?.[1];
    if (name === "request") {
      if (requestPart !== undefined || headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
        throw new GatewayHttpError(400, "redmine.contract_invalid", "request partが不正です");
      }
      try {
        requestPart = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(bodyStart, bodyStart + bodyLength)));
      } catch {
        throw new GatewayHttpError(400, "redmine.contract_invalid", "request JSONが不正です");
      }
    } else if (name === "evidence") {
      if (evidence) throw new GatewayHttpError(400, "redmine.contract_invalid", "evidence partが重複しています");
      const filename = /(?:^|;)\s*filename="([^"]+)"/u.exec(disposition)?.[1] ?? "";
      const partType = headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (!filename || /[\\/\u0000-\u001f]/u.test(filename) || (partType !== "image/png" && partType !== "image/webp")) {
        throw new GatewayHttpError(406, "redmine.content_type_rejected", "evidence filenameまたはcontent typeが不正です");
      }
      evidence = {
        bytes: bytes.slice(bodyStart, bodyStart + bodyLength),
        filename,
        contentType: partType
      };
    } else {
      throw new GatewayHttpError(400, "redmine.contract_invalid", "unknown multipart partがあります");
    }
  }
  if (requestPart === undefined) throw new GatewayHttpError(400, "redmine.contract_invalid", "request partがありません");
  return { request: requestPart, evidence };
}

function parseHeaders(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new GatewayHttpError(400, "redmine.contract_invalid", "multipart headerが不正です");
    const name = line.slice(0, separator).trim().toLowerCase();
    const headerValue = line.slice(separator + 1).trim();
    if (result.has(name)) throw new GatewayHttpError(400, "redmine.contract_invalid", "multipart headerが重複しています");
    result.set(name, headerValue);
  }
  return result;
}
