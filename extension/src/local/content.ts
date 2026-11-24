/**
 * A clip's content for manual upload (3.0 phase 6): metadata per destination and the viral-potential score,
 * stored on the clip row. Your edits per destination are kept when metadata is regenerated.
 */
import { db } from "./db";
import { listAssets } from "./assets";
import { getTranscript, quotes } from "./transcripts";
import type { LocalClip } from "./clips";
import type { Destination } from "./rights";
import { factsOf, fit, type ClipMetadata, type DestinationMeta } from "@/metadata/metadata";
import { generateMetadata, type GenerateDeps } from "@/metadata/generate";
import { scoreClip, type ClipScore } from "@/scoring/score";
import type { Settings } from "@/types/settings";
import type { Streamer } from "@/types/api";

export type ContentClip = LocalClip & { metadata?: ClipMetadata | null; viral?: ClipScore | null; original_url?: string | null };

export class ContentError extends Error {}

async function load(id: number): Promise<{ clip: ContentClip; streamer: Streamer | undefined }> {
  const clip = await db.get<ContentClip>("clips", id);
  if (!clip) throw new ContentError("That clip no longer exists.");
  const streamer = clip.streamer_id ? await db.get<Streamer>("streamers", clip.streamer_id) : undefined;
  return { clip, streamer };
}

/** Score again (cheap) and write metadata if there is none yet, or when `regenerate` is set. */
export async function prepareContent(id: number, settings: Settings, deps: GenerateDeps = {}, opts: { regenerate?: boolean; resetEdits?: boolean } = {}): Promise<ContentClip> {
  const { clip, streamer } = await load(id);
  const assets = await listAssets(id);
  const viral = scoreClip(clip, assets, settings, deps.now);
  let metadata = clip.metadata ?? null;
  if (!metadata || opts.regenerate) {
    const keep = opts.resetEdits || !metadata ? undefined : Object.fromEntries(metadata.edited.map((d) => [d, metadata!.byDestination[d]]));
    const q = quotes(await getTranscript(id));
    metadata = await generateMetadata({ ...factsOf(clip, streamer), ...(q.length ? { quotes: q } : {}) }, settings, deps, keep);
  }
  return db.put<ContentClip>("clips", { ...(await load(id)).clip, viral, metadata });
}

/** Your own text for one destination (limits and attribution still apply). */
export async function editMetadata(id: number, dest: Destination, patch: Partial<DestinationMeta>, settings: Settings): Promise<ContentClip> {
  if (!["youtube", "tiktok", "x"].includes(dest)) throw new ContentError("Unknown destination.");
  const { clip, streamer } = await load(id);
  if (!clip.metadata) throw new ContentError("This clip has no metadata yet.");
  const cur = clip.metadata.byDestination[dest];
  const next: DestinationMeta = {
    title: typeof patch.title === "string" ? patch.title : cur.title,
    description: typeof patch.description === "string" ? patch.description : cur.description,
    hashtags: Array.isArray(patch.hashtags) ? patch.hashtags.filter((x): x is string => typeof x === "string") : cur.hashtags,
  };
  const fitted = fit(dest, next, factsOf(clip, streamer), settings.metadata.attribution);
  const metadata: ClipMetadata = { ...clip.metadata, byDestination: { ...clip.metadata.byDestination, [dest]: fitted }, edited: [...new Set([...clip.metadata.edited, dest])] };
  return db.put<ContentClip>("clips", { ...clip, metadata });
}
