/**
 * Output files of a clip (3.0 phase 5): one vertical 9:16 asset (Shorts/TikTok) and one landscape
 * asset (X) per clip. Rows in `assets`, files in `assetBlobs` (key = asset id; thumbnail = -id).
 * A landscape asset that reuses the original clip stores no second copy.
 */
import type { VerticalLayout } from "@/types/api";
import { db } from "./db";
import type { LayoutKind } from "@/processing/layout";

export type AssetKind = "vertical" | "landscape";
export type AssetStatus = "queued" | "processing" | "ready" | "failed";

export interface Asset {
  id: number;
  clip_id: number;
  kind: AssetKind;
  /** Requested layout, resolved when queued: per-clip override → creator → default. */
  layout: VerticalLayout | null;
  /** Where the layout came from, for the UI. */
  layout_source: "clip" | "creator" | "default" | null;
  used_layout: LayoutKind | "landscape" | null;
  status: AssetStatus;
  error: string | null;
  attempts: number;
  progress: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  size_bytes: number;
  /** Landscape only: the original clip already met X's limits and is used as it is. */
  reused_original: boolean;
  has_thumbnail: boolean;
  notes: string[];
  created_at: string;
  updated_at: string;
}

export const MAX_ATTEMPTS = 2;

export async function listAssets(clip?: number): Promise<Asset[]> {
  const all = clip === undefined ? await db.all<Asset>("assets") : await db.byIndex<Asset>("assets", "clip", clip);
  return all.sort((a, b) => a.id - b.id);
}

export async function getAsset(id: number): Promise<Asset | undefined> {
  return db.get<Asset>("assets", id);
}

/** Queue (or re-queue) one asset per kind for a clip, replacing older versions of that kind. */
export async function queueAssets(clip: number, kinds: AssetKind[], layout: { layout: VerticalLayout | null; source: Asset["layout_source"] }, now = new Date()): Promise<Asset[]> {
  const existing = await listAssets(clip);
  const out: Asset[] = [];
  for (const kind of kinds) {
    for (const old of existing.filter((a) => a.kind === kind)) await deleteAsset(old.id);
    out.push(
      await db.put<Asset>("assets", {
        id: undefined as unknown as number,
        clip_id: clip,
        kind,
        layout: kind === "vertical" ? layout.layout : null,
        layout_source: kind === "vertical" ? layout.source : null,
        used_layout: null,
        status: "queued",
        error: null,
        attempts: 0,
        progress: 0,
        width: null,
        height: null,
        duration_seconds: null,
        size_bytes: 0,
        reused_original: false,
        has_thumbnail: false,
        notes: [],
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      }),
    );
  }
  return out;
}

export async function patchAsset(id: number, patch: Partial<Omit<Asset, "id" | "clip_id" | "kind">>, now = new Date()): Promise<Asset | undefined> {
  const a = await getAsset(id);
  if (!a) return undefined;
  return db.put<Asset>("assets", { ...a, ...patch, updated_at: now.toISOString() });
}

/** The asset's video: its own file, or the original clip when reused. */
export async function assetBlob(a: Pick<Asset, "id" | "clip_id" | "reused_original">): Promise<Blob | undefined> {
  return a.reused_original ? db.get<Blob>("clipBlobs", a.clip_id) : db.get<Blob>("assetBlobs", a.id);
}

export async function assetThumbnail(id: number): Promise<Blob | undefined> {
  return db.get<Blob>("assetBlobs", -id);
}

export async function deleteAsset(id: number): Promise<void> {
  await db.delete("assetBlobs", id);
  await db.delete("assetBlobs", -id);
  await db.delete("assets", id);
}

export async function deleteAssetsOf(clip: number): Promise<void> {
  for (const a of await listAssets(clip)) await deleteAsset(a.id);
}

/** The next asset to make. Rows left "processing" by a closed document are retried, then failed. */
export async function nextQueuedAsset(now = new Date()): Promise<Asset | undefined> {
  const all = await listAssets();
  for (const a of all.filter((x) => x.status === "processing")) {
    const attempts = a.attempts + 1;
    await patchAsset(a.id, attempts >= MAX_ATTEMPTS ? { status: "failed", attempts, error: "Processing was interrupted twice (the browser closed or ran out of memory)." } : { status: "queued", attempts }, now);
  }
  return (await listAssets()).find((a) => a.status === "queued");
}
