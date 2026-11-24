/**
 * 4.5 YouTube Video Clipper. Find a video (search or URL), say why you may use it (your own video,
 * written permission, or a licence) and approve or reject it, then import the file you obtained
 * through an authorized route (YouTube Studio's download for your own videos). StreamHunter analyses
 * it (loudness on this computer, speech with Whisper in the companion), proposes segments with the
 * measured reasons, and cuts only the segments you approve. YouTube showing a video, and your
 * confirmation here, are not proof of permission: StreamHunter records what you state.
 */
import { db } from "@/local/db";
import { atLeast, RightsError, validateRights, type Destination, type RightsStatus } from "@/local/rights";
import { addSource, requestSourceClip, type SourceFile, type SuggestedMoment } from "@/local/sources";
import { type Candidate, type ClipperDecision, type Found, type SourceBasis, upsertCandidates } from "@/discovery/discovery";

export const BASIS_LABEL: Record<SourceBasis, string> = {
  own: "My own video",
  permission: "Written permission from the rights holder",
  licensed: "Licensed for reuse (for example Creative Commons)",
};

// --- URLs ------------------------------------------------------------------------------------------

const ID = /^[\w-]{11}$/;

/** A YouTube video id from a URL you paste (watch, youtu.be, shorts, embed, live, music, mobile) or a bare id. */
export function parseYouTubeUrl(input: string): string | null {
  const s = input.trim();
  if (ID.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1] ?? "";
    return ID.test(id) ? id : null;
  }
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const v = u.searchParams.get("v");
  if (u.pathname === "/watch" && v && ID.test(v)) return v;
  const m = /^\/(shorts|embed|live|v)\/([\w-]{11})(?:[/?]|$)/.exec(u.pathname);
  return m ? m[2]! : null;
}

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** When there is no API key: a candidate with only what the URL says (details unknown). */
export function bareVideo(id: string): Found {
  return {
    platform: "youtube",
    source_id: id,
    kind: "video",
    title: `YouTube video ${id}`,
    creator_name: "",
    creator_id: null,
    url: watchUrl(id),
    thumbnail_url: null,
    published_at: null,
    duration_seconds: null,
    views: null,
    likes: null,
    comments: null,
    category: null,
    language: null,
    via: ["clipper"],
    reasons: ["Pasted URL (details unavailable without a YouTube API key)"],
  };
}

export async function saveFound(found: Found[], now = new Date()): Promise<Candidate[]> {
  await upsertCandidates(found, now);
  const out: Candidate[] = [];
  for (const f of found) {
    const c = await db.oneByIndex<Candidate>("candidates", "source", [f.platform, f.source_id]);
    if (c) out.push(c);
  }
  return out;
}

// --- approval --------------------------------------------------------------------------------------

export interface ApproveInput {
  basis: SourceBasis;
  status: RightsStatus;
  evidence: string;
  destinations?: Destination[];
  confirmed: boolean;
}

/**
 * Approve a video as a source: needs the basis, evidence, your confirmation, and at least
 * "Authorized for processing" (cutting clips). Reject records that you don't want it.
 */
export async function decideSource(candidateId: number, decision: { approve: true; input: ApproveInput } | { approve: false; note?: string }, now = new Date()): Promise<Candidate> {
  const c = await db.get<Candidate>("candidates", candidateId);
  if (!c) throw new RightsError("That video is no longer in StreamHunter.");
  if (c.platform !== "youtube") throw new RightsError("The Clipper works with YouTube videos.");
  if (!decision.approve) {
    const clipper: ClipperDecision = { approval: "rejected", basis: null, note: String(decision.note ?? "").slice(0, 300), decided_at: now.toISOString() };
    return db.put<Candidate>("candidates", { ...c, clipper, updated_at: now.toISOString() });
  }
  const i = decision.input;
  if (!i.basis || !(i.basis in BASIS_LABEL)) throw new RightsError("Choose why you may use this video.");
  const rights = validateRights({ status: i.status, evidence: i.evidence, destinations: i.destinations, confirmed: i.confirmed }, now);
  if (!atLeast(rights, "processing")) throw new RightsError('Approving a source needs at least "Authorized for processing" (cutting clips from it).');
  const clipper: ClipperDecision = { approval: "approved", basis: i.basis, note: "", decided_at: now.toISOString() };
  return db.put<Candidate>("candidates", { ...c, rights, clipper, updated_at: now.toISOString() });
}

export const isApproved = (c: Pick<Candidate, "clipper" | "rights"> | null | undefined) => c?.clipper?.approval === "approved" && atLeast(c.rights, "processing");

/** Import the file you obtained through an authorized route, for an approved video. */
export async function importForVideo(candidateId: number, file: Blob & { name?: string }, now = new Date()): Promise<SourceFile> {
  const c = await db.get<Candidate>("candidates", candidateId);
  if (!c) throw new RightsError("That video is no longer in StreamHunter.");
  if (!isApproved(c)) throw new RightsError("Approve the video as a source first (with why you may use it).");
  return addSource(file, { candidate_id: c.id, creator_name: c.creator_name || "YouTube creator", platform: "youtube", original_url: c.url }, { status: c.rights.status, evidence: c.rights.evidence, destinations: c.rights.destinations, confirmed: true }, now);
}

/**
 * Does the imported file look like the approved video? Compared by length (YouTube's duration is
 * whole seconds). null when either length is unknown.
 */
export function durationMatch(videoSec: number | null, fileSec: number | null): { ok: boolean; message: string } | null {
  if (!videoSec || !fileSec) return null;
  const diff = Math.abs(videoSec - fileSec);
  if (diff <= Math.max(2, videoSec * 0.01)) return { ok: true, message: `The file's length matches the video (${Math.round(fileSec)} s).` };
  return { ok: false, message: `The file is ${Math.round(fileSec)} s long but the YouTube video is ${Math.round(videoSec)} s. Is it the right file?` };
}

// --- segments --------------------------------------------------------------------------------------

export type SegmentStatus = "pending" | "approved" | "extracted" | "rejected" | "failed";
export interface Segment {
  id: number;
  source_id: number;
  start: number;
  end: number;
  score: number;
  reasons: string[];
  /** Whisper's words in this segment (empty when there is no transcript or no speech). */
  excerpt: string;
  status: SegmentStatus;
  clip_id: number | null;
  error: string | null;
  created_at: string;
}
export interface SpeechWord {
  w: string;
  s: number;
  e: number;
}
export interface SpeechSegment {
  start: number;
  end: number;
  text: string;
  words: SpeechWord[];
}

export const SEGMENT = { snapBefore: 3, snapAfter: 4, pad: 0.3, minLen: 3, maxLen: 180, max: 30, excerptChars: 140 } as const;

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Candidate segments from the measured moments (loudness and other signals from the analysis), with
 * Whisper's words: boundaries move to the start or end of a sentence that is cut (within a few
 * seconds), and the words inside become the excerpt. Nothing is added that wasn't measured or said.
 */
export function buildSegments(moments: SuggestedMoment[], speech: SpeechSegment[] | null, duration: number | null): Omit<Segment, "id" | "source_id" | "status" | "clip_id" | "error" | "created_at">[] {
  const end0 = duration ?? Infinity;
  const out = moments.map((m) => {
    let start = m.start;
    let end = m.end;
    let snapped = false;
    for (const s of speech ?? []) {
      if (s.start < start && s.end > start && start - s.start <= SEGMENT.snapBefore) {
        start = Math.max(0, s.start - SEGMENT.pad);
        snapped = true;
      }
      if (s.start < end && s.end > end && s.end - end <= SEGMENT.snapAfter) {
        end = Math.min(end0, s.end + SEGMENT.pad);
        snapped = true;
      }
    }
    start = Math.max(0, start);
    end = Math.min(end0, Math.max(end, start + SEGMENT.minLen), start + SEGMENT.maxLen);
    const words = (speech ?? []).flatMap((s) => s.words).filter((w) => w.s >= start && w.e <= end);
    let excerpt = words.map((w) => w.w).join(" ");
    if (excerpt.length > SEGMENT.excerptChars) excerpt = `${excerpt.slice(0, SEGMENT.excerptChars - 1).replace(/\s+\S*$/, "")}…`;
    const reasons = [...m.reasons];
    if (excerpt) reasons.push(`Speech: “${excerpt.length > 60 ? `${excerpt.slice(0, 59).replace(/\s+\S*$/, "")}…` : excerpt}”`);
    if (snapped) reasons.push("Starts and ends with whole sentences");
    return { start: r1(start), end: r1(end), score: m.score, reasons, excerpt };
  });
  // Overlapping by more than half: keep the stronger one.
  const kept: typeof out = [];
  for (const s of [...out].sort((a, b) => b.score - a.score)) {
    const clash = kept.some((k) => Math.min(k.end, s.end) - Math.max(k.start, s.start) > 0.5 * Math.min(k.end - k.start, s.end - s.start));
    if (!clash && s.end - s.start >= SEGMENT.minLen) kept.push(s);
    if (kept.length >= SEGMENT.max) break;
  }
  return kept.sort((a, b) => a.start - b.start);
}

export async function listSegments(sourceId?: number): Promise<Segment[]> {
  const all = sourceId === undefined ? await db.all<Segment>("segments") : await db.byIndex<Segment>("segments", "source", sourceId);
  return all.sort((a, b) => a.source_id - b.source_id || a.start - b.start);
}

/** (Re)build a source's segments; your decisions on earlier segments are kept. */
export async function saveSegments(source: SourceFile, now = new Date()): Promise<Segment[]> {
  const speech = source.transcript?.segments ?? null;
  const fresh = buildSegments(source.moments, speech, source.duration_seconds);
  const old = await listSegments(source.id);
  for (const o of old) if (o.status === "pending") await db.delete("segments", o.id);
  const decided = old.filter((o) => o.status !== "pending");
  for (const f of fresh) {
    if (decided.some((d) => Math.abs(d.start - f.start) < 1 && Math.abs(d.end - f.end) < 1)) continue;
    await db.put<Segment>("segments", { ...f, id: undefined as unknown as number, source_id: source.id, status: "pending", clip_id: null, error: null, created_at: now.toISOString() });
  }
  return listSegments(source.id);
}

/** Approve: the segment is cut into a clip (then edited by the usual score rules). Reject: never cut. */
export async function decideSegment(id: number, approve: boolean): Promise<Segment> {
  const seg = await db.get<Segment>("segments", id);
  if (!seg) throw new RightsError("That segment no longer exists.");
  if (seg.status === "extracted") throw new RightsError("This segment is already a clip.");
  if (!approve) return db.put<Segment>("segments", { ...seg, status: "rejected" });
  const source = await db.get<SourceFile>("sources", seg.source_id);
  if (!source) throw new RightsError("The source file was removed.");
  const cand = source.candidate_id !== null ? await db.get<Candidate>("candidates", source.candidate_id) : undefined;
  if (cand && !isApproved(cand)) throw new RightsError("The video isn't approved as a source.");
  const m = Math.floor(seg.start / 60);
  const title = `${source.creator_name} – ${m}:${String(Math.floor(seg.start % 60)).padStart(2, "0")}`;
  await requestSourceClip(source.id, { start: seg.start, end: seg.end, title, score: seg.score, reasons: seg.reasons.slice(0, 4), segment_id: seg.id });
  return db.put<Segment>("segments", { ...seg, status: "approved", error: null });
}

export async function deleteSegmentsOf(sourceId: number): Promise<void> {
  for (const s of await listSegments(sourceId)) await db.delete("segments", s.id);
}
