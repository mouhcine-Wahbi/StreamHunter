import type { Clip } from "@/types/api";
import { db } from "./db";

/**
 * A clip is a real video file cut from a capture's rolling buffer and stored in IndexedDB
 * (`clipBlobs`, keyed by clip id). It always belongs to a highlight that has video.
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
}

export async function saveClip(c: NewClip): Promise<LocalClip> {
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
    source: "auto",
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
  });
  await db.putBlob(clip.id, c.blob);
  return clip;
}

export async function listClips(): Promise<LocalClip[]> {
  return (await db.all<LocalClip>("clips")).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function clipBlob(id: number): Promise<Blob | undefined> {
  return db.get<Blob>("clipBlobs", id);
}

export async function renameClip(id: number, title: string): Promise<LocalClip> {
  const c = await db.get<LocalClip>("clips", id);
  if (!c) throw new Error("Clip not found");
  return db.put("clips", { ...c, title: title.trim().slice(0, 140) || c.title });
}

export async function deleteClip(id: number): Promise<void> {
  await db.delete("clipBlobs", id);
  await db.delete("clips", id);
}

/** A safe file name for the download. */
export function clipFileName(c: Pick<LocalClip, "streamer_display_name" | "started_at" | "mime_type" | "id">): string {
  const base = `${c.streamer_display_name}_${c.started_at.slice(0, 19).replace(/[:T]/g, "-")}_${c.id}`.replace(/[^\w.-]+/g, "_");
  return `${base}.${c.mime_type.includes("webm") ? "webm" : "mp4"}`;
}
