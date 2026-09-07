// 検索の一回の観測だけを検証する。件数1をprovider全体の一意性証明とは扱わない。
import assert from "node:assert/strict";

export function assertBestEffortDuplicateRecovery(candidates, query, result) {
  const first = candidates[0]?.projection;
  const matches = first?.intentId === query.intentId && first?.requestHash === query.requestHash;
  const expected = candidates.length === 0 ? "pending"
    : candidates.length > 1 || !matches ? "repair_required" : "completed";
  assert.equal(result.state, expected, "実際に観測した候補と回収判断が一致しません");
  // completedにはこのfieldがない。未確定結果だけがfalseを必須とする。
  if (expected === "completed") assert.equal(result.automaticWriteAllowed, undefined);
  else assert.equal(result.automaticWriteAllowed, false);
  if (expected === "repair_required") assert.equal(result.retryDirective, "do-not-write");
  return { observedCandidateCount: candidates.length, recoveryState: result.state, globalUniquenessProven: false };
}
