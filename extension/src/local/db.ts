/**
 * StreamHunter's local database (IndexedDB). Everything an editor builds up lives here:
 * the monitoring list, live/offline sessions, highlights, clips and the clip videos themselves.
 * Preferences and platform credentials live in chrome.storage.local instead (small, synced to
 * every extension page through storage events).
 *
 * Works the same in the service worker, the offscreen document and extension pages.
 */

export const DB_NAME = "streamhunter";
export const DB_VERSION = 7;

export type StoreName =
  | "streamers" | "sessions" | "highlights" | "clips" | "clipBlobs" | "clipThumbs"
  // v3 (3.0): discovery, authorized sources, output assets, rights
  | "candidates" | "sources" | "sourceBlobs" | "assets" | "assetBlobs" | "rights"
  // v5 (4.0): editing jobs run by the companion
  | "editJobs"
  // v6 (4.4): Whisper transcripts, one per clip
  | "transcripts"
  // v7 (4.5): YouTube Video Clipper candidate segments
  | "segments";
export type BlobStore = "clipBlobs" | "clipThumbs" | "sourceBlobs" | "assetBlobs";

function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) createV1(db);
  // v2: a JPEG thumbnail per clip (key = clip id → Blob image/jpeg).
  if (!db.objectStoreNames.contains("clipThumbs")) db.createObjectStore("clipThumbs");
  if (oldVersion < 3) createV3(db);
  // v4: StreamHunter doesn't publish (you upload clips yourself); the publishing jobs store is removed.
  if (oldVersion < 4 && db.objectStoreNames.contains("jobs")) db.deleteObjectStore("jobs");
  // v5 (4.0): one row per edit of a clip; the same clip + template + options is never edited twice.
  if (oldVersion < 5) {
    const edits = db.createObjectStore("editJobs", { keyPath: "id", autoIncrement: true });
    edits.createIndex("clip", "clip_id");
    edits.createIndex("dedupe", "dedupe_key", { unique: true });
  }
  // v6 (4.4): one transcript per clip (key = clip id).
  if (oldVersion < 6) db.createObjectStore("transcripts", { keyPath: "clip_id" });
  // v7 (4.5): candidate segments of an authorized source, each approved or rejected by you.
  if (oldVersion < 7) db.createObjectStore("segments", { keyPath: "id", autoIncrement: true }).createIndex("source", "source_id");
}

/** 3.0: existing stores and data are untouched; only new stores are added. */
function createV3(db: IDBDatabase): void {
  // Discovered videos (never downloaded): one row per platform video/clip.
  const candidates = db.createObjectStore("candidates", { keyPath: "id", autoIncrement: true });
  candidates.createIndex("source", ["platform", "source_id"], { unique: true });
  // Video files you added and marked authorized (metadata; the file itself in sourceBlobs).
  const sources = db.createObjectStore("sources", { keyPath: "id", autoIncrement: true });
  sources.createIndex("candidate", "candidate_id");
  db.createObjectStore("sourceBlobs");
  // Output videos (vertical 9:16, landscape) linked to one clip.
  const assets = db.createObjectStore("assets", { keyPath: "id", autoIncrement: true });
  assets.createIndex("clip", "clip_id");
  db.createObjectStore("assetBlobs");
  // Rights per creator (key "platform:platform_user_id").
  db.createObjectStore("rights", { keyPath: "key" });
}

function createV1(db: IDBDatabase): void {
  const streamers = db.createObjectStore("streamers", { keyPath: "id", autoIncrement: true });
  streamers.createIndex("platformUser", ["platform", "platform_user_id"], { unique: true });
  const sessions = db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
  sessions.createIndex("streamer", "streamer_id");
  const highlights = db.createObjectStore("highlights", { keyPath: "id", autoIncrement: true });
  highlights.createIndex("streamer", "streamer_id");
  const clips = db.createObjectStore("clips", { keyPath: "id", autoIncrement: true });
  clips.createIndex("candidate", "candidate_id");
  db.createObjectStore("clipBlobs"); // key = clip id → Blob (video/mp4)
}

let opening: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error("Could not open the local database"));
    };
  });
  return opening;
}

/** Forget the cached connection (tests swap in a fresh IndexedDB). */
export function resetDbConnection(): void {
  opening = null;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Local database error"));
  });
}

async function tx(store: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(store, mode).objectStore(store);
}

export const db = {
  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return done((await tx(store, "readonly")).get(key)) as Promise<T | undefined>;
  },
  async all<T>(store: StoreName): Promise<T[]> {
    return done((await tx(store, "readonly")).getAll()) as Promise<T[]>;
  },
  async byIndex<T>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
    return done((await tx(store, "readonly")).index(index).getAll(key)) as Promise<T[]>;
  },
  async oneByIndex<T>(store: StoreName, index: string, key: IDBValidKey): Promise<T | undefined> {
    return done((await tx(store, "readonly")).index(index).get(key)) as Promise<T | undefined>;
  },
  /** Insert (no id yet) → returns the new id; or replace by id. */
  async put<T extends { id?: number }>(store: StoreName, value: T): Promise<T & { id: number }> {
    const v = { ...value };
    if (v.id === undefined) delete v.id;
    const id = (await done((await tx(store, "readwrite")).put(v))) as number;
    return { ...v, id } as T & { id: number };
  },
  async putBlob(key: number, blob: Blob, store: BlobStore = "clipBlobs"): Promise<void> {
    await done((await tx(store, "readwrite")).put(blob, key));
  },
  /** Insert or replace a row whose key is a string field (rights). */
  async putKeyed<T extends object>(store: StoreName, value: T): Promise<T> {
    await done((await tx(store, "readwrite")).put(value));
    return value;
  },
  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    await done((await tx(store, "readwrite")).delete(key));
  },
};
