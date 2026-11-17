import type { CandidateStatus, Clip, HighlightCandidate, MonitoringSession, Streamer } from "@/types/api";
import { db } from "./db";

/**
 * A highlight is a moment worth looking at. Two kinds, never confused:
 * - provisional (`has_video: false`): found from chat or viewer numbers while nobody recorded the
 *   stream. It has a time and a score, and an "Open stream" link, but no video.
 * - captured (`has_video: true`): it happened while the editor was capturing that stream, so a
 *   clip (a real MP4 in IndexedDB) exists for it.
 */
export type LocalHighlight = HighlightCandidate & {
  session_id: number | null;
  has_video: boolean;
  created_at: string;
  /** The moment's window (pre/post roll included), wall-clock ms: what a capture clip covers. */
  window_start_ms: number;
  window_end_ms: number;
};

export interface NewHighlight {
  streamer: Pick<Streamer, "id" | "display_name" | "username" | "platform">;
  session: Pick<MonitoringSession, "id" | "broadcast_started_at"> | null;
  origin: "chat" | "viewers" | "capture";
  peakAt: number;
  startAt: number;
  endAt: number;
  score: number;
  confidence: number;
  category: string;
  reasons: string[];
  breakdown: Record<string, unknown>;
}

const offset = (session: NewHighlight["session"], t: number) =>
  session?.broadcast_started_at ? Math.max(0, Math.round((t - Date.parse(session.broadcast_started_at)) / 100) / 10) : null;

export async function createHighlight(h: NewHighlight): Promise<LocalHighlight> {
  const now = new Date().toISOString();
  return db.put<LocalHighlight>("highlights", {
    id: undefined as unknown as number,
    streamer_id: h.streamer.id,
    streamer_display_name: h.streamer.display_name,
    streamer_username: h.streamer.username,
    platform: h.streamer.platform,
    session_id: h.session?.id ?? null,
    origin: h.origin as HighlightCandidate["origin"],
    timestamp: new Date(h.peakAt).toISOString(),
    start_offset_sec: offset(h.session, h.startAt),
    end_offset_sec: offset(h.session, h.endAt),
    score: h.score,
    confidence: h.confidence,
    category: h.category,
    reasons: h.reasons,
    signal_breakdown: h.breakdown as HighlightCandidate["signal_breakdown"],
    status: "pending_review",
    has_video: false,
    clip: null,
    created_at: now,
    window_start_ms: h.startAt,
    window_end_ms: h.endAt,
  });
}

export async function listHighlights(): Promise<LocalHighlight[]> {
  const [all, clips] = await Promise.all([db.all<LocalHighlight>("highlights"), db.all<Clip>("clips")]);
  const byCandidate = new Map(clips.map((c) => [c.candidate_id, c]));
  return all
    .map((h) => {
      const c = byCandidate.get(h.id);
      return { ...h, has_video: Boolean(c), clip: c ? { id: c.id, status: c.status, platform_clip_url: null, error_message: c.error_message } : null };
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function getHighlight(id: number): Promise<LocalHighlight | undefined> {
  return (await listHighlights()).find((h) => h.id === id);
}

const ALLOWED: CandidateStatus[] = ["pending_review", "approved", "rejected"];

export async function setHighlightStatus(id: number, status: CandidateStatus): Promise<LocalHighlight> {
  const h = await db.get<LocalHighlight>("highlights", id);
  if (!h) throw new Error("Highlight not found");
  if (!ALLOWED.includes(status)) throw new Error(`Unsupported status ${status}`);
  return db.put("highlights", { ...h, status });
}

export async function deleteHighlight(id: number): Promise<void> {
  await db.delete("highlights", id);
}

/**
 * Retention: provisional highlights (no clip) and ended sessions older than `days` are deleted.
 * Highlights with a clip stay as long as their clip.
 */
export async function pruneOldData(days: number, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const [all, clips, sessions] = await Promise.all([
    db.all<LocalHighlight>("highlights"),
    db.all<Clip>("clips"),
    db.all<MonitoringSession>("sessions"),
  ]);
  const withClip = new Set(clips.map((c) => c.candidate_id));
  let removed = 0;
  for (const h of all) {
    if (h.timestamp < cutoff && !withClip.has(h.id)) {
      await db.delete("highlights", h.id);
      removed += 1;
    }
  }
  for (const s of sessions) if (s.status === "ended" && (s.ended_at ?? s.started_at) < cutoff) await db.delete("sessions", s.id);
  return removed;
}
