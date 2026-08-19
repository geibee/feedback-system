import { createRoot } from "react-dom/client";
import {
  parseProfileResult,
  type RedmineProfileResult
} from "@feedback/redmine-core";
import {
  RedmineFeedbackOverlay,
  RedmineFeedbackProvider,
  installRedmineFeedbackStyles
} from "@feedback/redmine-react";
import { createExtensionClientState } from "./client-state.js";
import { ExtensionRedmineFeedbackTransport, type RuntimeLike } from "./extension-transport.js";
import { createExtensionHostBridge } from "./host-bridge.js";

const marker = "feedbackRedmineExtensionMounted";
const scope = globalThis as typeof globalThis & { [marker]?: boolean };
if (!scope[marker]) {
  scope[marker] = true;
  void bootstrap(chrome.runtime as unknown as RuntimeLike);
}

async function bootstrap(runtime: RuntimeLike): Promise<void> {
  const profileResult = await bootstrapProfile(runtime);
  const host = document.createElement("div");
  host.dataset.feedbackRedmineExtension = "true";
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  installRedmineFeedbackStyles(shadow);
  const mount = document.createElement("div");
  shadow.append(mount);
  const root = createRoot(mount);
  if (!profileResult.capabilities.canRead) {
    root.render(<button type="button" onClick={() => void chrome.runtime.openOptionsPage()}>Feedbackをoptionsでunlock</button>);
    return;
  }
  const profileId = profileResult.profile.id;
  const profile = {
    ...profileResult.profile,
    hostOrigins: [location.origin]
  };
  const adapter = await createExtensionHostBridge(profile);
  root.render(
    <RedmineFeedbackProvider runtime={{
      profileId,
      port: new ExtensionRedmineFeedbackTransport(profileId, runtime),
      clientState: createExtensionClientState(runtime),
      adapter
    }}>
      <RedmineFeedbackOverlay />
    </RedmineFeedbackProvider>
  );
}

function bootstrapProfile(runtime: RuntimeLike): Promise<RedmineProfileResult> {
  const port = runtime.connect({ name: "feedback-redmine-bootstrap-v1" });
  return new Promise((resolve, reject) => {
    let settled = false;
    port.onMessage.addListener((message) => {
      try {
        const response = message as { ok?: unknown; result?: unknown; error?: { message?: unknown } };
        if (response.ok !== true) throw new Error(typeof response.error?.message === "string" ? response.error.message : "profile bootstrapに失敗しました");
        settled = true;
        resolve(parseProfileResult(response.result));
      } catch (error) { reject(error); }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) reject(new Error("profile bootstrap Portが切断されました"));
    });
  });
}
