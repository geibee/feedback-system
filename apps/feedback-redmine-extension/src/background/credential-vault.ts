import type { ExtensionStorage } from "../storage/chrome-storage.js";

export class CredentialVault {
  constructor(private readonly storage: ExtensionStorage) {}

  async get(profileId: string): Promise<string | null> {
    const key = credentialKey(profileId);
    const value = (await this.storage.session.get(key))[key];
    return typeof value === "string" && value ? value : null;
  }

  async unlock(profileId: string, apiKey: string): Promise<void> {
    if (!profilePattern.test(profileId) || !apiKey || apiKey.length > 255) throw new Error("credentialが不正です");
    await this.storage.session.set({ [credentialKey(profileId)]: apiKey });
  }

  async lock(profileId: string): Promise<void> {
    await this.storage.session.remove(credentialKey(profileId));
  }
}

const credentialKey = (profileId: string) => `feedback.redmine.v1:${encodeURIComponent(profileId)}:credential`;
const profilePattern = /^[a-z0-9][a-z0-9._-]{0,99}$/u;
