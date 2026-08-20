import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { InspectionReport } from "./inspect.js";

export function renderManualChecklist(report: InspectionReport): string {
  const lines = [
    "# Feedback Redmine手動確認チェックリスト",
    "",
    `- Redmine version: ${report.redmineVersion ?? "取得不能"}`,
    `- manual check digest: \`${report.manualCheckDigest}\``,
    "",
    "Redmine管理画面で次の全項目を確認してください。確認対象を変更した場合はinspectを再実行し、新しいdigestを使用します。",
    ""
  ];
  for (const check of report.manualChecks) {
    const marker = check.status === "accepted" ? "x" : " ";
    lines.push(`- [${marker}] \`${check.key}\`: ${singleLine(check.detail)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function writeManualChecklist(path: string, report: InspectionReport): Promise<void> {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, renderManualChecklist(report), { mode: 0o600 });
}

export async function writeGeneratedProfilesAtomically(
  path: string,
  generated: NonNullable<InspectionReport["generated"]>
): Promise<void> {
  const directory = resolve(path);
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".feedback-redmine-generated-"));
  try {
    await Promise.all([
      writeFile(join(staging, "client-profile.json"), `${JSON.stringify(generated.clientProfile, null, 2)}\n`, { mode: 0o600, flag: "wx" }),
      writeFile(join(staging, "server-profile.json"), `${JSON.stringify(generated.serverProfile, null, 2)}\n`, { mode: 0o600, flag: "wx" }),
      writeFile(join(staging, "runtime-config.json"), `${JSON.stringify(generated.runtimeConfig, null, 2)}\n`, { mode: 0o644, flag: "wx" })
    ]);
    await rename(staging, directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}
