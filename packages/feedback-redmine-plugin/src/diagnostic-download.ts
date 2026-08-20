import { RedmineDiagnosticBuffer } from "@geibee/redmine-core";

export function downloadDiagnosticJson(diagnostics: RedmineDiagnosticBuffer, profileId: string): void {
  const document = diagnostics.document();
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = globalThis.document.createElement("a");
  link.href = url;
  link.download = `feedback-redmine-diagnostic-${profileId}-${document.generatedAt.replace(/[:.]/gu, "-")}.json`;
  link.hidden = true;
  globalThis.document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
