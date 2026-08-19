import type { ExtensionProfileRepository } from "../storage/chrome-storage.js";

const registrationId = "feedback-redmine-content-v1";

export async function synchronizeContentScriptRegistration(
  scripting: Pick<typeof chrome.scripting, "getRegisteredContentScripts" | "registerContentScripts" | "unregisterContentScripts">,
  profiles: ExtensionProfileRepository,
  permissions?: Pick<typeof chrome.permissions, "contains">
): Promise<void> {
  const candidates = [...new Set((await profiles.list()).flatMap((profile) => profile.hostOrigins.map((origin) => `${origin}/*`)))].sort();
  const matches = permissions
    ? (await Promise.all(candidates.map(async (origin) => await permissions.contains({ origins: [origin] }) ? origin : null)))
      .filter((origin): origin is string => origin !== null)
    : candidates;
  const existing = await scripting.getRegisteredContentScripts({ ids: [registrationId] });
  if (existing.length) await scripting.unregisterContentScripts({ ids: [registrationId] });
  if (!matches.length) return;
  await scripting.registerContentScripts([{
    id: registrationId,
    js: ["content.js"],
    matches,
    persistAcrossSessions: true,
    runAt: "document_idle",
    world: "ISOLATED"
  }]);
}
