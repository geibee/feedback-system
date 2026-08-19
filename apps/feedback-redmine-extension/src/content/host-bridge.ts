import { createDomEvidenceProvider } from "@feedback/redmine-react";
import { sha256Hex, type FeedbackRedmineHostAdapter } from "@feedback/redmine-core";
import type { ExtensionProfileV1 } from "../profile.js";

type ExtensionHostProfile = Pick<
  ExtensionProfileV1,
  "applicationKey" | "environmentKey" | "externalWorkspaceKey" | "capture"
>;

export async function createExtensionHostBridge(profile: ExtensionHostProfile): Promise<FeedbackRedmineHostAdapter> {
  let current = await pageIdentity();
  const listeners = new Set<() => void>();
  const update = () => void pageIdentity().then((next) => {
    if (next.digest === current.digest) return;
    current = next;
    listeners.forEach((listener) => listener());
  });
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: profile.applicationKey,
      environmentKey: profile.environmentKey,
      externalWorkspaceKey: profile.externalWorkspaceKey,
      release: document.querySelector<HTMLMetaElement>('meta[name="application-version"]')?.content || "extension",
      locale: document.documentElement.lang || navigator.language || "ja-JP"
    }),
    getLocation: () => ({
      schemaVersion: "1",
      pageKey: `web.${current.digest.slice(0, 32)}`,
      routeTemplate: "/{page}",
      pathParameters: { page: `sha256:${current.digest}` }
    }),
    getResourceRef: () => ({ schemaVersion: "1", kind: "page", key: current.digest }),
    subscribe: (listener) => {
      listeners.add(listener);
      addEventListener("popstate", update);
      addEventListener("hashchange", update);
      return () => {
        listeners.delete(listener);
        removeEventListener("popstate", update);
        removeEventListener("hashchange", update);
      };
    },
    navigate: () => undefined,
    captureEvidence: createDomEvidenceProvider({ maxBytes: profile.capture.maximumUploadBytes, maxPixelRatio: 2 })
  };
}

async function pageIdentity(): Promise<{ digest: string }> {
  const value = `${location.origin}${location.pathname}`;
  return { digest: await sha256Hex(new TextEncoder().encode(value)) };
}
