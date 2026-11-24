/**
 * Authorized sources (3.0): video files you add yourself because you're allowed to use them.
 * StreamHunter never downloads a discovered video; to work with one, you add the file and say why
 * you're allowed to (rights evidence). Files stay in this browser (IndexedDB).
 */
import type { Candidate } from "@/discovery/discovery";
import type { Platform } from "@/types/api";
import { db } from "./db";
import { atLeast, check, RightsError, validateRights, type Rights } from "./rights";

export type AnalysisStatus = "not_analyzed" | "queued" | "analyzing" | "analyzed" | "failed";

export interface SuggestedMoment {
  /** Seconds from the start of the file. */
  at: number;
  start: number;
  end: number;
  score: number;
  reasons: string[];
  kinds: string[];
}

export interface SourceFile {
  id: number;
  candidate_id: number | null;
  name: string;
  mime: string;
  size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  creator_name: string;
  platform: Platform | "local";
  /** Original URL or stream identifier, for provenance and attribution. */
  original_url: string | null;
  rights: Rights;
  analysis: AnalysisStatus;
  analysis_error: string | null;
  moments: SuggestedMoment[];
  /** Clips you asked for, made one at a time by the processing queue. */
  pending_clips?: ClipRequest[];
  clip_ids?: number[];
  clip_error?: string | null;
  /** 4.5: Whisper transcript of the whole file (companion), used for segment excerpts and boundaries. */
  transcript?: { model: string; language: string | null; segments: { start: number; end: number; text: string; words: { w: string; s: number; e: number }[] }[]; dropped: number; created_at: string } | null;
  transcript_status?: "none" | "running" | "done" | "failed" | "unavailable";
  /** 4.6: how the file arrived: imported by you, or fetched with yt-dlp (opt-in) after your confirmation. */
  obtained_via?: "import" | "yt-dlp";
  transcript_error?: string | null;
  added_at: string;
}

export interface ClipRequest {
  start: number;
  end: number;
  title?: string;
  score?: number;
  reasons?: string[];
  /** 4.5: the Clipper segment this clip is cut for. */
  segment_id?: number;
}

export const MAX_SOURCE_BYTES = 4 * 1024 ** 3;
/** 4.7: an import must leave this much of the browser's storage free (recording pauses below it too). */
export const STORAGE_RESERVE = 2 * 1024 ** 3;

/** null when there is room for `bytes` more in this browser's storage (or it can't be measured). */
export async function noRoomFor(bytes: number): Promise<string | null> {
  const e = await navigator.storage?.estimate?.().catch(() => null);
  if (!e?.quota || e.usage == null) return null;
  const free = e.quota - e.usage;
  if (free - bytes >= STORAGE_RESERVE) return null;
  const gb = (b: number) => `${(Math.max(0, b) / 1024 ** 3).toFixed(1)} GB`;
  return `Not enough browser storage: the file needs ${gb(bytes)}, ${gb(free)} is free, and StreamHunter keeps ${gb(STORAGE_RESERVE)} free. Delete clips or source files (System Health → Storage) or free disk space.`;
}
const VIDEO_TYPES = /^video\/(mp4|quicktime|webm|x-matroska)$/;

/** Add a file you're authorized to use. Needs at least "authorized for analysis" with evidence. */
export async function addSource(
  file: Blob & { name?: string },
  meta: { candidate_id?: number | null; creator_name: string; platform?: SourceFile["platform"]; original_url?: string | null },
  rightsInput: Parameters<typeof validateRights>[0],
  now = new Date(),
): Promise<SourceFile> {
  if (!VIDEO_TYPES.test(file.type)) throw new RightsError("Choose an MP4, MOV or WebM video file.");
  if (file.size === 0 || file.size > MAX_SOURCE_BYTES) throw new RightsError("The file is empty or larger than 4 GB.");
  const room = await noRoomFor(file.size);
  if (room) throw new RightsError(room);
  const rights = validateRights(rightsInput, now);
  if (!atLeast(rights, "analysis")) throw new RightsError("StreamHunter only works with files you're authorized to use: choose at least \"Authorized for analysis\".");
  let candidate: Candidate | undefined;
  if (meta.candidate_id != null) {
    candidate = await db.get<Candidate>("candidates", meta.candidate_id);
    if (!candidate) throw new RightsError("That discovered video no longer exists.");
  }
  const row = await db.put<SourceFile>("sources", {
    id: undefined as unknown as number,
    candidate_id: candidate?.id ?? null,
    name: (file.name ?? "video").slice(0, 200),
    mime: file.type,
    size_bytes: file.size,
    duration_seconds: null,
    width: null,
    height: null,
    creator_name: (meta.creator_name || candidate?.creator_name || "Unknown creator").slice(0, 100),
    platform: meta.platform ?? candidate?.platform ?? "local",
    original_url: meta.original_url ?? candidate?.url ?? null,
    rights,
    analysis: "not_analyzed",
    analysis_error: null,
    moments: [],
    added_at: now.toISOString(),
  });
  await db.putBlob(row.id, file, "sourceBlobs");
  if (candidate) await db.put<Candidate>("candidates", { ...candidate, rights, processing: "source_added", updated_at: now.toISOString() });
  return row;
}

export async function listSources(): Promise<SourceFile[]> {
  return (await db.all<SourceFile>("sources")).sort((a, b) => b.added_at.localeCompare(a.added_at));
}

export async function updateSource(
  id: number,
  patch: Partial<Pick<SourceFile, "analysis" | "analysis_error" | "moments" | "duration_seconds" | "width" | "height" | "pending_clips" | "clip_ids" | "clip_error" | "transcript" | "transcript_status" | "transcript_error" | "obtained_via">>,
): Promise<SourceFile> {
  const s = await db.get<SourceFile>("sources", id);
  if (!s) throw new RightsError("That source file no longer exists.");
  return db.put("sources", { ...s, ...patch });
}

/** Ask for an analysis (needs "Authorized for analysis"). */
export async function requestAnalysis(id: number): Promise<SourceFile> {
  const s = await db.get<SourceFile>("sources", id);
  if (!s) throw new RightsError("That source file no longer exists.");
  const ok = check(s.rights, "analyze");
  if (!ok.ok) throw new RightsError(ok.reason);
  if (!/mp4|quicktime/.test(s.mime)) throw new RightsError("Only MP4 and MOV files can be analysed and cut for now.");
  return updateSource(id, { analysis: "queued", analysis_error: null });
}

/** Ask for a clip from [start, end) seconds (needs "Authorized for processing"; 3–180 s). */
export async function requestSourceClip(id: number, req: ClipRequest): Promise<SourceFile> {
  const s = await db.get<SourceFile>("sources", id);
  if (!s) throw new RightsError("That source file no longer exists.");
  const ok = check(s.rights, "process");
  if (!ok.ok) throw new RightsError(ok.reason);
  if (!/mp4|quicktime/.test(s.mime)) throw new RightsError("Only MP4 and MOV files can be cut for now.");
  const start = Math.max(0, Number(req.start));
  const end = Number(req.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3 || end - start > 180) throw new RightsError("A clip must be between 3 seconds and 3 minutes long.");
  if (s.duration_seconds !== null && start >= s.duration_seconds) throw new RightsError("That start is after the end of the file.");
  const clean: ClipRequest = { start, end, title: typeof req.title === "string" ? req.title.slice(0, 140) : "", score: typeof req.score === "number" ? req.score : 0, reasons: Array.isArray(req.reasons) ? req.reasons.slice(0, 4).map(String) : [], ...(Number.isInteger(req.segment_id) ? { segment_id: req.segment_id } : {}) };
  return updateSource(id, { pending_clips: [...(s.pending_clips ?? []), clean].slice(-20), clip_error: null });
}

export async function deleteSource(id: number): Promise<void> {
  for (const seg of await db.byIndex<{ id: number }>("segments", "source", id)) await db.delete("segments", seg.id);
  await db.delete("sources", id);
  await db.delete("sourceBlobs", id);
}

export async function sourceBlob(id: number): Promise<Blob | undefined> {
  return db.get<Blob>("sourceBlobs", id);
}

// --- candidates ------------------------------------------------------------------------------------

export async function updateCandidate(id: number, patch: { dismissed?: unknown; rights?: Parameters<typeof validateRights>[0] }, now = new Date()): Promise<Candidate> {
  const c = await db.get<Candidate>("candidates", id);
  if (!c) throw new RightsError("That discovered video no longer exists.");
  const next = { ...c, updated_at: now.toISOString() };
  if (typeof patch.dismissed === "boolean") next.dismissed = patch.dismissed;
  if (patch.rights) next.rights = validateRights(patch.rights, now);
  return db.put("candidates", next);
}
