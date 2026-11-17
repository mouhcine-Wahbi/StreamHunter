/**
 * Rolling buffer of *encoded* audio/video chunks (H.264 + AAC/Opus from WebCodecs), about the last
 * two minutes. A clip is cut from it without re-encoding: from the last keyframe at or before the
 * clip start (keyframes every 2 s) to the clip end.
 *
 * Timestamps are wall-clock milliseconds (Date.now() scale), so chat-detected moments and the
 * capture line up.
 */
export interface Chunk {
  kind: "video" | "audio";
  key: boolean;
  /** Wall-clock ms of the chunk start. */
  at: number;
  /** Duration in ms. */
  duration: number;
  data: Uint8Array;
}

export class ChunkRing {
  private video: Chunk[] = [];
  private audio: Chunk[] = [];
  bytes = 0;

  constructor(public keepMs: number) {}

  push(c: Chunk): void {
    (c.kind === "video" ? this.video : this.audio).push(c);
    this.bytes += c.data.byteLength;
    this.trim(c.at);
  }

  /** Drop what is older than keepMs, but never the keyframe the oldest kept video depends on. */
  private trim(now: number): void {
    const cutoff = now - this.keepMs;
    let firstKeep = 0;
    for (let i = 0; i < this.video.length; i++) {
      const c = this.video[i]!;
      if (c.at >= cutoff) break;
      if (c.key) firstKeep = i;
    }
    // Keep from the newest keyframe that is still before the cutoff.
    if (firstKeep > 0) this.drop(this.video, firstKeep);
    const vStart = this.video[0]?.at ?? cutoff;
    let a = 0;
    while (a < this.audio.length && this.audio[a]!.at < Math.min(cutoff, vStart)) a++;
    if (a > 0) this.drop(this.audio, a);
  }

  private drop(list: Chunk[], n: number) {
    for (const c of list.splice(0, n)) this.bytes -= c.data.byteLength;
  }

  get oldest(): number | null {
    return this.video[0]?.at ?? null;
  }

  get newest(): number | null {
    return this.video.at(-1)?.at ?? null;
  }

  /**
   * Chunks for [start, end]: video from the last keyframe ≤ start (or the first keyframe after it
   * when the buffer doesn't reach back that far), audio over the same span.
   */
  select(start: number, end: number): { video: Chunk[]; audio: Chunk[]; from: number; to: number } | null {
    let first = -1;
    for (let i = 0; i < this.video.length; i++) {
      const c = this.video[i]!;
      if (c.at > start && first >= 0) break;
      if (c.key && (c.at <= start || first < 0)) first = i;
    }
    if (first < 0) return null;
    const video = this.video.slice(first).filter((c) => c.at <= end);
    if (video.length === 0) return null;
    const from = video[0]!.at;
    const to = video.at(-1)!.at + video.at(-1)!.duration;
    const audio = this.audio.filter((c) => c.at + c.duration > from && c.at < to);
    return { video, audio, from, to };
  }
}
