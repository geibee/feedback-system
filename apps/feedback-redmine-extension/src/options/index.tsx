import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RedmineDiagnosticDocumentV1 } from "@feedback/redmine-core";
import type { ExtensionProfileV1, ExtensionProfilesV1 } from "../profile.js";
import {
  ExtensionProfileRepository,
  restrictExtensionStorage,
  type ExtensionStorage
} from "../storage/chrome-storage.js";
import { synchronizeContentScriptRegistration } from "../background/registration.js";

const storage = chrome.storage as unknown as ExtensionStorage;
const repository = new ExtensionProfileRepository(storage);

function Options() {
  const [profiles, setProfiles] = useState<ExtensionProfileV1[]>([]);
  const [source, setSource] = useState('{\n  "schemaVersion": "1",\n  "profiles": []\n}\n');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  const refresh = async () => setProfiles(await repository.list());
  useEffect(() => { void restrictExtensionStorage(storage).then(refresh); }, []);

  const importProfiles = async () => {
    try {
      const document = await repository.saveLocal(JSON.parse(source) as ExtensionProfilesV1);
      await synchronizeContentScriptRegistration(chrome.scripting, repository, chrome.permissions);
      setMessage(`${document.profiles.length}件のlocal profileを保存しました。`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "profileを保存できません");
    }
  };

  const requestPermissions = async (profile: ExtensionProfileV1) => {
    const origins = permissionOrigins(profile);
    const granted = await chrome.permissions.request({ origins });
    setMessage(granted ? "業務画面とRedmineのorigin permissionを許可しました。" : "origin permissionは許可されませんでした。");
    if (granted) await synchronizeContentScriptRegistration(chrome.scripting, repository, chrome.permissions);
  };

  const unlock = async (profile: ExtensionProfileV1) => {
    const apiKey = keys[profile.id] ?? "";
    const response = await chrome.runtime.sendMessage({
      contractVersion: "1",
      requestId: crypto.randomUUID(),
      type: "profile.unlock.v1",
      payload: { profileId: profile.id, apiKey }
    }) as {
      ok?: unknown;
      result?: { customFieldValidation?: unknown };
      error?: { message?: unknown };
    };
    setKeys((current) => ({ ...current, [profile.id]: "" }));
    setMessage(response.ok === true
      ? response.result?.customFieldValidation === "not-yet-proven"
        ? "Redmine接続とproject readを確認してunlockしました。issueが0件のためcustom fieldはまだ証明されていません。"
        : "Redmine接続、project read、必須custom fieldを確認し、このbrowser sessionでunlockしました。"
      :
      typeof response.error?.message === "string" ? response.error.message : "unlockできませんでした");
  };

  const lock = async (profile: ExtensionProfileV1) => {
    await chrome.runtime.sendMessage({
      contractVersion: "1", requestId: crypto.randomUUID(), type: "profile.lock.v1", payload: { profileId: profile.id }
    });
    setMessage("profileをlockしました。");
  };

  const downloadDiagnostics = async (profile: ExtensionProfileV1) => {
    const response = await chrome.runtime.sendMessage({
      contractVersion: "1", requestId: crypto.randomUUID(), type: "diagnostic.download.v1", payload: { profileId: profile.id }
    }) as { ok?: unknown; result?: RedmineDiagnosticDocumentV1; error?: { message?: unknown } };
    if (response.ok !== true || !response.result) {
      setMessage(typeof response.error?.message === "string" ? response.error.message : "diagnosticを取得できませんでした");
      return;
    }
    const blob = new Blob([`${JSON.stringify(response.result, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `feedback-redmine-diagnostic-${profile.id}-${response.result.generatedAt.replace(/[:.]/gu, "-")}.json`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage("secretや業務本文を含まないlocal diagnostic JSONをdownloadしました。");
  };

  const remove = async (profile: ExtensionProfileV1) => {
    const oldOrigins = permissionOrigins(profile);
    await repository.removeLocal(profile.id);
    const remaining = await repository.list();
    const stillUsed = new Set(remaining.flatMap(permissionOrigins));
    const removable = oldOrigins.filter((origin) => !stillUsed.has(origin));
    if (removable.length) await chrome.permissions.remove({ origins: removable });
    await synchronizeContentScriptRegistration(chrome.scripting, repository, chrome.permissions);
    setMessage("local profileと関連する端末内stateを削除しました。managed profileは削除されません。");
    await refresh();
  };

  return <main>
    <h1>Feedback for Redmine 設定</h1>
    <p>API keyはbrowser sessionだけに保持され、profile JSONやlocal storageへ保存されません。</p>
    {message && <p role="status">{message}</p>}
    <section>
      <h2>local profile JSON</h2>
      <textarea rows={18} value={source} onChange={(event) => setSource(event.target.value)} />
      <button type="button" onClick={() => void importProfiles()}>検証して保存</button>
    </section>
    <section>
      <h2>有効なprofile</h2>
      {profiles.length === 0 && <p>profileがありません。</p>}
      {profiles.map((profile) => <article key={profile.id}>
        <h3>{profile.displayName}</h3>
        <code>{profile.id}</code>
        <p>{profile.hostOrigins.join(", ")} → {new URL(profile.redmineBaseUrl).origin}</p>
        <button type="button" onClick={() => void requestPermissions(profile)}>origin permissionを許可</button>
        <label>Redmine API key
          <input
            type="password"
            autoComplete="off"
            value={keys[profile.id] ?? ""}
            onChange={(event) => setKeys((current) => ({ ...current, [profile.id]: event.target.value }))}
          />
        </label>
        <button type="button" disabled={!keys[profile.id]} onClick={() => void unlock(profile)}>接続確認してunlock</button>
        <button type="button" onClick={() => void lock(profile)}>lock</button>
        <button type="button" onClick={() => void downloadDiagnostics(profile)}>local diagnosticをdownload</button>
        <button type="button" onClick={() => void remove(profile)}>local profileを削除</button>
      </article>)}
    </section>
  </main>;
}

function permissionOrigins(profile: ExtensionProfileV1): string[] {
  return [...new Set([...profile.hostOrigins, new URL(profile.redmineBaseUrl).origin])].map((origin) => `${origin}/*`);
}

const style = document.createElement("style");
style.textContent = "body{font-family:system-ui,sans-serif;margin:0;color:#172033}main{max-width:960px;margin:auto;padding:32px}section,article{display:grid;gap:10px;border:1px solid #ccd5e3;border-radius:10px;padding:16px;margin:16px 0}textarea,input{font:inherit;padding:8px}button{justify-self:start;padding:8px 12px}";
document.head.append(style);
const mount = document.getElementById("feedback-redmine-options");
if (!mount) throw new Error("options mountがありません");
createRoot(mount).render(<Options />);
