/**
 * Whisper transcripts with hallucination guards (pure functions, tested without Whisper).
 *
 * Whisper invents text over sound with no speech ("Thank you." over a steady tone, with a
 * no-speech probability of 0), and its segment times can run past the end of the file. So every word
 * is checked against the sound itself: speech rises and falls between syllables, a tone, hum or
 * silence doesn't. Words with no speech-like sound under them are dropped, and a segment that loses
 * most of its words is dropped whole. The text that is kept is Whisper's own, unchanged.
 */

export const WHISPER_MODEL = "large-v3-turbo";
export const FRAME_SEC = 0.02;
/** A 20 ms frame is "speech-like" when it is audible and the sound around it (±0.5 s) varies. */
export const ACTIVITY = { minDb: -50, minStdDb: 3, windowFrames: 25 };
export const GUARDS = {
  /** Whisper's own rule: likely no speech and low confidence. */
  noSpeechProb: 0.6,
  lowLogprob: -1,
  /** Repeated text (a classic hallucination loop). */
  maxCompression: 2.4,
  /** A word needs this share of speech-like frames under it (with a little padding). */
  wordSpeechShare: 0.3,
  wordPad: 0.15,
  /** A segment is dropped when fewer than this share of its words survive. */
  keepWordsShare: 0.5,
};

/** 16-bit little-endian mono PCM → loudness (dBFS) of each 20 ms frame. */
export function envelope(pcm, rate = 16000) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const w = Math.round(rate * FRAME_SEC);
  const out = new Float32Array(Math.floor(samples.length / w));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let i = f * w; i < (f + 1) * w; i++) s += samples[i] * samples[i];
    out[f] = 10 * Math.log10(s / w / 32768 ** 2 + 1e-12);
  }
  return out;
}

/** Speech-like frames: audible, and the loudness around them varies (syllables, pauses). */
export function activity(db, a = ACTIVITY) {
  const n = db.length;
  const act = new Uint8Array(n);
  // Running sums over the window for mean and variance.
  const sum = new Float64Array(n + 1);
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    sum[i + 1] = sum[i] + db[i];
    sq[i + 1] = sq[i] + db[i] * db[i];
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - a.windowFrames);
    const hi = Math.min(n, i + a.windowFrames + 1);
    const k = hi - lo;
    const mean = (sum[hi] - sum[lo]) / k;
    const sd = Math.sqrt(Math.max(0, (sq[hi] - sq[lo]) / k - mean * mean));
    act[i] = db[i] > a.minDb && sd > a.minStdDb ? 1 : 0;
  }
  return act;
}

export function speechShare(act, start, end, pad = 0) {
  const a = Math.max(0, Math.floor((start - pad) / FRAME_SEC));
  const b = Math.min(act.length, Math.ceil((end + pad) / FRAME_SEC));
  if (b <= a) return 0;
  let n = 0;
  for (let i = a; i < b; i++) n += act[i];
  return n / (b - a);
}

const round = (x) => Math.round(x * 100) / 100;

/**
 * Whisper JSON (with word timestamps) → kept segments and the dropped ones with the reason.
 * `act` comes from activity(); `duration` is the audio length in seconds.
 */
export function cleanTranscript(whisper, act, duration, g = GUARDS) {
  const segments = [];
  const dropped = [];
  for (const s of whisper?.segments ?? []) {
    const text = String(s.text ?? "").trim();
    if (!text) continue;
    const drop = (reason) => dropped.push({ start: round(s.start), end: round(Math.min(s.end, duration)), text, reason });
    if (s.start >= duration) {
      drop("after the end of the audio");
      continue;
    }
    if (s.compression_ratio > g.maxCompression) {
      drop("repeated text");
      continue;
    }
    if (s.no_speech_prob > g.noSpeechProb && s.avg_logprob < g.lowLogprob) {
      drop("Whisper found no speech");
      continue;
    }
    const words = (s.words ?? [])
      .map((w) => ({ word: String(w.word ?? "").trim(), start: Math.max(0, w.start), end: Math.min(w.end, duration), p: w.probability ?? null }))
      .filter((w) => w.word && w.start < duration && w.end > w.start);
    const kept = words.filter((w) => speechShare(act, w.start, w.end, g.wordPad) >= g.wordSpeechShare);
    if (!words.length || kept.length < words.length * g.keepWordsShare) {
      drop("no speech in the sound");
      continue;
    }
    segments.push({
      start: round(kept[0].start),
      end: round(kept.at(-1).end),
      text: kept.length === words.length ? text : kept.map((w) => w.word).join(" "),
      words: kept.map((w) => ({ w: w.word, s: round(w.start), e: round(w.end) })),
    });
  }
  return { segments, dropped };
}

/** Arguments for the openai-whisper CLI. No network: the model must already be in modelDir. */
export function whisperArgs({ input, outDir, modelDir, language, threads }) {
  const a = [input, "--model", WHISPER_MODEL, "--model_dir", modelDir, "--output_format", "json", "--output_dir", outDir, "--word_timestamps", "True", "--condition_on_previous_text", "False", "--fp16", "False", "--verbose", "False", "--threads", String(threads)];
  if (language) a.push("--language", language);
  return a;
}
