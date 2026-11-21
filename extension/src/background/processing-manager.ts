/**
 * Worker side of the 3.0 processing queue. The work itself runs in the offscreen document
 * (WebCodecs); the worker decides what to make (formats from Settings, layout per clip → creator →
 * default), stores it as queued assets, wakes the queue, and reacts when items finish.
 */
import { db } from "@/local/db";
import { queueAssets, type Asset, type AssetKind } from "@/local/assets";
import type { LocalClip } from "@/local/clips";
import { resolveLayout } from "@/processing/layout";
import type { Settings } from "@/types/settings";
import type { Streamer, VerticalLayout } from "@/types/api";

export interface ProcessingDeps {
  ensureOffscreen: () => Promise<void>;
  kick: () => Promise<unknown>;
  /** Close the offscreen document when nothing records and nothing is processed. */
  closeIfIdle: () => Promise<void>;
  /** A finished asset (phase 6/7 hook: metadata, scoring, publishing). */
  onAssetReady?: (assetId: number, clipId: number) => Promise<void>;
}

export class ProcessingError extends Error {}

export function createProcessingManager(deps: ProcessingDeps) {
  async function kick() {
    await deps.ensureOffscreen();
    await deps.kick();
  }

  async function makeAssets(clipId: number, settings: Settings, kinds?: AssetKind[], override?: VerticalLayout | null): Promise<Asset[]> {
    const clip = await db.get<LocalClip>("clips", clipId);
    if (!clip) throw new ProcessingError("That clip no longer exists.");
    const want = kinds ?? ([settings.formats.vertical && "vertical", settings.formats.landscape && "landscape"].filter(Boolean) as AssetKind[]);
    if (!want.length) return [];
    const creator = clip.streamer_id ? await db.get<Streamer>("streamers", clip.streamer_id) : undefined;
    const r = resolveLayout(override, creator?.layout, settings.formats.verticalLayout);
    const assets = await queueAssets(clipId, want, { layout: r.layout, source: r.source });
    await kick();
    return assets;
  }

  return {
    makeAssets,
    kick,
    /** A new clip (recorded or cut from an authorized file): make the formats chosen in Settings. */
    async onClipSaved(clipId: number, settings: Settings) {
      if (settings.formats.vertical || settings.formats.landscape) await makeAssets(clipId, settings).catch(() => undefined);
    },
    async onEvent(e: { type: "process/clip-made"; clipId: number } | { type: "process/asset-done"; assetId: number; clipId: number; ok: boolean } | { type: "process/idle" }, settings: Settings) {
      if (e.type === "process/clip-made") await this.onClipSaved(e.clipId, settings);
      else if (e.type === "process/asset-done") {
        if (e.ok) await deps.onAssetReady?.(e.assetId, e.clipId);
      } else await deps.closeIfIdle();
    },
  };
}

export type ProcessingManager = ReturnType<typeof createProcessingManager>;
