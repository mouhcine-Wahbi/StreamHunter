/**
 * The Clip Library's view of a clip (pure, tested): its overall status, the files you can
 * download, the text you copy for each platform, and the filters. StreamHunter never uploads
 * anything; you download the files and upload them yourself.
 */
import type { Asset, AssetKind } from "@/local/assets";
import type { ContentClip } from "@/local/content";
import type { Destination } from "@/local/rights";
import { clipFileName } from "@/local/clips";
import type { DestinationMeta } from "@/metadata/metadata";

export type LibraryStatus = "generating" | "ready" | "failed";

export const STATUS_LABEL: Record<LibraryStatus, string> = { generating: "Generating", ready: "Ready", failed: "Failed" };

export const DEST_FORMAT: Record<Destination, AssetKind> = { youtube: "vertical", tiktok: "vertical", x: "landscape" };

export type LibraryClip = ContentClip & { source_id?: number; source_offset_sec?: number };

/** Generating while a version is waiting or being made; failed when a version failed (or the clip has an error); otherwise ready. */
export function libraryStatus(clip: LibraryClip, assets: Asset[]): { status: LibraryStatus; detail: string | null } {
  if (assets.some((a) => a.status === "queued" || a.status === "processing")) {
    const kinds = assets.filter((a) => a.status === "queued" || a.status === "processing").map((a) => KIND_LABEL[a.kind].toLowerCase());
    return { status: "generating", detail: `Making the ${kinds.join(" and ")} version…` };
  }
  const failed = assets.filter((a) => a.status === "failed");
  if (failed.length) return { status: "failed", detail: failed.map((a) => `${KIND_LABEL[a.kind]} version failed${a.error ? `: ${a.error}` : "."}`).join(" ") };
  if (clip.error_message) return { status: "failed", detail: clip.error_message };
  return { status: "ready", detail: null };
}

export const KIND_LABEL: Record<AssetKind, string> = { vertical: "Vertical 9:16", landscape: "Landscape" };

/** A file name per version, next to the original's: `<creator>_<time>_<id>-vertical.mp4`. */
export function versionFileName(clip: LibraryClip, kind: AssetKind | "original"): string {
  const name = clipFileName(clip);
  if (kind === "original") return name;
  return name.replace(/\.(mp4|webm)$/, `-${kind}.mp4`);
}

export function hashtagText(meta: DestinationMeta): string {
  return meta.hashtags.join(" ");
}

/** Everything to paste for one platform: title (where the platform has one), text, hashtags not already in the text. */
export function allMetadataText(dest: Destination, meta: DestinationMeta): string {
  const tags = meta.hashtags.filter((t) => !meta.description.includes(t));
  return [dest === "youtube" && meta.title ? meta.title : null, meta.description, tags.length ? tags.join(" ") : null].filter(Boolean).join("\n\n");
}

/** When the moment was detected: the strongest signal, else the clip's first frame. */
export function detectedAt(clip: LibraryClip): string {
  return clip.peak_at ?? clip.started_at;
}

export interface LibraryFilters {
  creator: string;
  format: "all" | AssetKind;
  minScore: number;
  from: string;
  to: string;
  status: "all" | LibraryStatus;
}

export const NO_FILTERS: LibraryFilters = { creator: "", format: "all", minScore: 0, from: "", to: "", status: "all" };

/** The viral-potential score when there is one, else the detection score. */
export function displayScore(clip: LibraryClip): number {
  return clip.viral?.total ?? clip.score;
}

/** `from`/`to` are dates (YYYY-MM-DD) in your time zone, both inclusive. */
export function applyFilters(clips: LibraryClip[], assetsOf: (id: number) => Asset[], f: LibraryFilters): LibraryClip[] {
  const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : -Infinity;
  const to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : Infinity;
  return clips.filter((c) => {
    const at = new Date(detectedAt(c)).getTime();
    const assets = assetsOf(c.id);
    return (
      (!f.creator || c.streamer_display_name === f.creator) &&
      (f.format === "all" || assets.some((a) => a.kind === f.format && a.status === "ready")) &&
      displayScore(c) >= f.minScore &&
      at >= from &&
      at <= to &&
      (f.status === "all" || libraryStatus(c, assets).status === f.status)
    );
  });
}
