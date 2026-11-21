/**
 * Authorized sources (3.0): video files you add yourself because you're allowed to use them.
 * StreamHunter never downloads a discovered video; to work with one, you add the file and say why
 * you're allowed to (rights evidence). Files stay in this browser (IndexedDB).
 */
import type { Candidate } from "@/discovery/discovery";
import type { Platform } from "@/types/api";
import { db } from "./db";
import { atLeast, RightsError, validateRights, type Rights } from "./rights";

export type AnalysisStatus = "not_analyzed" | "analyzing" | "analyzed" | "failed";

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
  added_at: string;
}

export const MAX_SOURCE_BYTES = 4 * 1024 ** 3;
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

export async function updateSource(id: number, patch: Partial<Pick<SourceFile, "analysis" | "analysis_error" | "moments" | "duration_seconds" | "width" | "height">>): Promise<SourceFile> {
  const s = await db.get<SourceFile>("sources", id);
  if (!s) throw new RightsError("That source file no longer exists.");
  return db.put("sources", { ...s, ...patch });
}

export async function deleteSource(id: number): Promise<void> {
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
