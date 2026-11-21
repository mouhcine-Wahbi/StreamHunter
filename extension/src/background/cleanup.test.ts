/**
 * StreamHunter doesn't publish: updating from a 3.0 build that did must remove the publishing
 * data and keep everything else (clips, settings you chose).
 */
import { DB_NAME, db, openDb, resetDbConnection } from "@/local/db";
import { sanitizeSettings } from "@/utils/settings";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { ALARMS, syncMaintenanceAlarm } from "./alarm-manager";
import { removePublishingData } from "./cleanup";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** A database as a 3.0 build with publishing left it: version 3, with a jobs store. */
async function seedV3(): Promise<void> {
  const open = indexedDB.open(DB_NAME, 3);
  open.onupgradeneeded = () => {
    const d = open.result;
    for (const s of ["streamers", "sessions", "highlights", "clips", "candidates", "sources", "assets", "jobs"]) d.createObjectStore(s, { keyPath: "id", autoIncrement: true });
    for (const s of ["clipBlobs", "clipThumbs", "sourceBlobs", "assetBlobs"]) d.createObjectStore(s);
    d.createObjectStore("rights", { keyPath: "key" });
  };
  const d = await req(open);
  const t = d.transaction(["clips", "jobs"], "readwrite");
  t.objectStore("clips").put({ id: 1, title: "Kept clip" });
  t.objectStore("jobs").put({ id: 1, clip_id: 1, destination: "youtube", state: "queued" });
  await new Promise((r) => (t.oncomplete = r));
  d.close();
}

describe("removing publishing (update from an earlier 3.0 build)", () => {
  it("the database upgrade drops the publishing jobs store and keeps your clips", async () => {
    await seedV3();
    resetDbConnection();
    const d = await openDb();
    expect(d.version).toBe(4);
    expect([...d.objectStoreNames]).not.toContain("jobs");
    expect(await db.get("clips", 1)).toMatchObject({ title: "Kept clip" });
  });

  it("deletes the saved publishing accounts and leaves other storage alone", async () => {
    await chrome.storage.local.set({ "sh.publishAccounts": { x: { token: "t" } }, "sh.settings": { a: 1 } });
    await removePublishingData();
    const left = await chrome.storage.local.get(null);
    expect(left).not.toHaveProperty("sh.publishAccounts");
    expect(left).toHaveProperty("sh.settings");
  });

  it("replaces the old publishing timer with the maintenance timer", async () => {
    await chrome.alarms.create("sh-publishing", { periodInMinutes: 5 });
    await syncMaintenanceAlarm();
    expect(await chrome.alarms.get("sh-publishing")).toBeUndefined();
    expect(await chrome.alarms.get(ALARMS.maintenance)).toBeDefined();
  });

  it("settings: keeps your credit choice and score thresholds from the old names, drops publishing", () => {
    const s = sanitizeSettings({
      scoring: { publishThreshold: 90, reviewThreshold: 55 },
      publishing: { autoPublish: true, attribution: false, destinations: { youtube: { enabled: true, dailyLimit: 5 } }, maxRetries: 3 },
    });
    expect(s.metadata.attribution).toBe(false);
    expect(s.scoring.highThreshold).toBe(90);
    expect(s.scoring.mediumThreshold).toBe(55);
    expect(s).not.toHaveProperty("publishing");
    expect(sanitizeSettings({ scoring: { highThreshold: 70, mediumThreshold: 80 } }).scoring).toMatchObject({ mediumThreshold: 80, highThreshold: 80 });
    expect(sanitizeSettings({}).metadata.attribution).toBe(DEFAULT_SETTINGS.metadata.attribution);
  });
});
