/**
 * 4.4: transcripts made on this computer by the companion (Whisper large-v3-turbo). One per clip.
 * Only Whisper's own words are kept, after the companion dropped text with no speech under it.
 */
import { db } from "./db";

export interface TranscriptWord {
  w: string;
  /** Seconds from the start of the clip. */
  s: number;
  e: number;
}
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}
export interface Transcript {
  clip_id: number;
  model: string;
  language: string | null;
  duration: number;
  segments: TranscriptSegment[];
  /** Text Whisper produced over sound with no speech (kept for transparency, never used). */
  dropped: { start: number; end: number; text: string; reason: string }[];
  metrics: { wall_ms: number; cpu_ms: number; peak_rss_bytes: number } | null;
  created_at: string;
}

export const getTranscript = (clipId: number) => db.get<Transcript>("transcripts", clipId);
export const putTranscript = (t: Transcript) => db.putKeyed<Transcript>("transcripts", t);
export const deleteTranscript = (clipId: number) => db.delete("transcripts", clipId);

/** "0:07" */
export function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Up to `max` spoken lines with their times, for metadata facts (exact words, never paraphrased). */
export function quotes(t: Transcript | undefined | null, max = 6, maxChars = 600): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  let n = 0;
  for (const s of t?.segments ?? []) {
    if (out.length >= max || n + s.text.length > maxChars) break;
    out.push({ at: s.start, text: s.text });
    n += s.text.length;
  }
  return out;
}
