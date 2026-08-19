import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** @typedef {{version: string, requestedTag: string, officialDigest: string | null, availability: "available" | "missing-upstream"}} MatrixImage */
/** @type {{images: MatrixImage[]}} */
const lock = JSON.parse(readFileSync(new URL("../images.lock.json", import.meta.url), "utf8"));

test("Redmine matrixは計画指定4 versionを順序どおり保持する", () => {
  assert.deepEqual(lock.images.map((image) => image.version), ["5.1.12", "6.0.10", "6.1.3", "7.0.0"]);
  for (const image of lock.images) {
    assert.equal(image.availability, "available");
    assert(image.officialDigest);
    assert.match(image.officialDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(image.requestedTag, `${image.version}-bookworm`);
  }
});

test("全versionをDocker Official Imageのexact tagとdigestへ固定する", () => {
  assert.equal(lock.images.some((image) => image.availability !== "available" || !image.officialDigest), false);
  assert.equal(new Set(lock.images.map((image) => image.officialDigest)).size, lock.images.length);
});
