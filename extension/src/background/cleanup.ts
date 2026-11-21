/**
 * StreamHunter doesn't publish: you download clips and upload them yourself. Earlier 3.0 builds on
 * this branch could connect YouTube / TikTok / X accounts; any tokens they stored are deleted here
 * (on every start, so it also covers updates). The publishing jobs store is dropped by the database
 * upgrade (db.ts, v4).
 */
export const OLD_PUBLISHING_KEYS = ["sh.publishAccounts"] as const;

export async function removePublishingData(): Promise<void> {
  await chrome.storage.local.remove([...OLD_PUBLISHING_KEYS]);
}
