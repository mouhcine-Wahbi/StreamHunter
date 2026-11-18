import type { Clip } from "@/types/api";
import { db } from "./db";

/** What found a clip: fused signal kinds, or "manual" for Save last N s. */
export type DetectionType = "audio" | "chat" | "visual" | "viewers" | "manual";

/**
 * A clip is a real video file cut from a capture's rolling buffer and stored in IndexedDB
 * (`clipBlobs`, keyed by clip id; a JPEG thumbnail in `clipThumbs`). It always belongs to a
 * highlight that has video.
 */
export type LocalClip = Clip & {
  session_id: number | null;
  streamer_id: number;
  streamer_display_name: string;
  size_bytes: number;
  mime_type: string;
  width: number | null;
  height: number | null;
  /** Wall-clock time of the first frame. */
  started_at: string;
  score: number;
  /** Stream category (game) when the clip was recorded. */
  category: string | null;
  reasons: string[];
  detection_types: DetectionType[];
  /** Wall-clock time of the strongest signal. */
  peak_at: string | null;
  /** Seconds into the broadcast where the clip starts (null when unknown). */
  stream_offset_sec: number | null;
  favorite: boolean;
  has_thumbnail: boolean;
  /** Why this score: points per signal kind (+ multi-signal bonus), confidence, how long the event lasted. */
  score_parts?: Record<"audio" | "chat" | "visual" | "viewers" | "multi", number> | null;
  confidence?: number | null;
  event_seconds?: number | null;
};

export interface NewClip {
  candidateId: number;
  sessionId: number | null;
  streamerId: number;
  streamerName: string;
  platform: Clip["platform"];
  title: string;
  startedAt: number;
  durationSec: number;
  width: number | null;
  height: number | null;
  score: number;
  blob: Blob;
  category?: string | null;
  reasons?: string[];
  detectionTypes?: DetectionType[];
  peakAt?: number | null;
  broadcastStartedAt?: string | null;
  thumbnail?: Blob | null;
  explain?: { parts: Record<"audio" | "chat" | "visual" | "viewers" | "multi", number>; confidence: number; eventSeconds: number } | null;
}

/** Older clips (saved before these fields existed) read with safe defaults. */
export function normalizeClip(c: LocalClip): LocalClip {
  return {
    ...c,
    category: c.category ?? null,
    reasons: c.reasons ?? [],
    detection_types: c.detection_types ?? [],
    peak_at: c.peak_at ?? null,
    stream_offset_sec: c.stream_offset_sec ?? null,
    favorite: c.favorite ?? false,
    has_thumbnail: c.has_thumbnail ?? false,
  };
}

export async function saveClip(c: NewClip): Promise<LocalClip> {
  const offset = c.broadcastStartedAt ? Math.max(0, Math.round((c.startedAt - Date.parse(c.broadcastStartedAt)) / 1000)) : null;
  const clip = await db.put<LocalClip>("clips", {
    id: undefined as unknown as number,
    candidate_id: c.candidateId,
    session_id: c.sessionId,
    streamer_id: c.streamerId,
    streamer_display_name: c.streamerName,
    platform: c.platform,
    platform_clip_id: null,
    platform_clip_url: null,
    local_file_path: null,
    subtitles_file_path: null,
    title: c.title,
    duration_seconds: Math.round(c.durationSec * 10) / 10,
    aspect_ratio: c.width && c.height ? `${c.width}x${c.height}` : null,
    status: "ready",
    error_message: null,
    source: c.detectionTypes?.includes("manual") ? "manual" : "auto",
    edit_url: null,
    requested_at: null,
    request_lag_seconds: null,
    published_at: null,
    published_url: null,
    created_at: new Date().toISOString(),
    size_bytes: c.blob.size,
    mime_type: c.blob.type || "video/mp4",
    width: c.width,
    height: c.height,
    started_at: new Date(c.startedAt).toISOString(),
    score: c.score,
    category: c.category ?? null,
    reasons: c.reasons ?? [],
    detection_types: c.detectionTypes ?? [],
    peak_at: c.peakAt ? new Date(c.peakAt).toISOString() : null,
    stream_offset_sec: offset !== null && Number.isFinite(offset) ? offset : null,
    favorite: false,
    has_thumbnail: Boolean(c.thumbnail),
    score_parts: c.explain?.parts ?? null,
    confidence: c.explain?.confidence ?? null,
    event_seconds: c.explain?.eventSeconds ?? null,
  });
  await db.putBlob(clip.id, c.blob);
  if (c.thumbnail) await db.putBlob(clip.id, c.thumbnail, "clipThumbs");
  return clip;
}

export async function listClips(): Promise<LocalClip[]> {
  return (await db.all<LocalClip>("clips")).map(normalizeClip).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function clipBlob(id: number): Promise<Blob | undefined> {
  return db.get<Blob>("clipBlobs", id);
}

export async function clipThumbnail(id: number): Promise<Blob | undefined> {
  return db.get<Blob>("clipThumbs", id);
}

export async function updateClip(id: number, patch: { title?: unknown; favorite?: unknown; reasons?: string[]; score?: number; platform_clip_id?: string | null; platform_clip_url?: string | null; edit_url?: string | null; error_message?: string | null }): Promise<LocalClip> {
  const raw = await db.get<LocalClip>("clips", id);
  if (!raw) throw new Error("Clip not found");
  const c = normalizeClip(raw);
  const next: LocalClip = { ...c };
  if (typeof patch.title === "string") next.title = patch.title.trim().slice(0, 140) || c.title;
  if (typeof patch.favorite === "boolean") next.favorite = patch.favorite;
  if (Array.isArray(patch.reasons)) next.reasons = patch.reasons.slice(0, 8);
  if (typeof patch.score === "number") next.score = Math.max(c.score, Math.round(patch.score));
  for (const k of ["platform_clip_id", "platform_clip_url", "edit_url", "error_message"] as const) if (k in patch) next[k] = patch[k] ?? null;
  return db.put("clips", next);
}

export async function renameClip(id: number, title: string): Promise<LocalClip> {
  return updateClip(id, { title });
}

export async function deleteClip(id: number): Promise<void> {
  await db.delete("clipBlobs", id);
  await db.delete("clipThumbs", id);
  await db.delete("clips", id);
}

/** What to tell the editor when a clip could not be written to browser storage. */
export function saveFailureReason(e: unknown): string {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "QuotaExceededError" || /quota/i.test(err?.message ?? "")) return "Browser storage is full: delete clips or lower the storage limit in Settings.";
  return `The clip could not be stored (${err?.message ?? "unknown error"}).`;
}

/** A safe file name for the download. */
export function clipFileName(c: Pick<LocalClip, "streamer_display_name" | "started_at" | "mime_type" | "id">): string {
  const base = `${c.streamer_display_name}_${c.started_at.slice(0, 19).replace(/[:T]/g, "-")}_${c.id}`.replace(/[^\w.-]+/g, "_");
  return `${base}.${c.mime_type.includes("webm") ? "webm" : "mp4"}`;
}

export interface StorageLimits {
  maxTotalMb: number;
  /** 0 = no age limit. */
  maxAgeDays: number;
}

export interface CleanupResult {
  deleted: number[];
  freedBytes: number;
  totalBytes: number;
}

/**
 * Keeps the Clip Library within the limits: clips older than maxAgeDays, then the oldest clips
 * while the total is above maxTotalMb, are deleted (video, thumbnail and their highlight).
 * Favourites are never deleted automatically.
 */
export async function enforceStorageLimits(limits: StorageLimits, now: Date): Promise<CleanupResult> {
  const clips = (await listClips()).sort((a, b) => a.created_at.localeCompare(b.created_at)); // oldest first
  let total = clips.reduce((a, c) => a + c.size_bytes, 0);
  const max = limits.maxTotalMb * 1_048_576;
  const cutoff = limits.maxAgeDays > 0 ? new Date(now.getTime() - limits.maxAgeDays * 86_400_000).toISOString() : null;
  const deleted: number[] = [];
  let freed = 0;
  for (const c of clips) {
    if (c.favorite) continue;
    const tooOld = cutoff !== null && c.created_at < cutoff;
    if (!tooOld && total <= max) continue;
    await deleteClip(c.id);
    await db.delete("highlights", c.candidate_id).catch(() => undefined);
    deleted.push(c.id);
    freed += c.size_bytes;
    total -= c.size_bytes;
  }
  return { deleted, freedBytes: freed, totalBytes: total };
}

/** Totals for the Overview. */
export async function clipStats(): Promise<{ count: number; totalBytes: number; totalSeconds: number; favorites: number }> {
  const clips = await listClips();
  return {
    count: clips.length,
    totalBytes: clips.reduce((a, c) => a + c.size_bytes, 0),
    totalSeconds: Math.round(clips.reduce((a, c) => a + (c.duration_seconds ?? 0), 0)),
    favorites: clips.filter((c) => c.favorite).length,
  };
}
