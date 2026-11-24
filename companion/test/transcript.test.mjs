// 4.4: Whisper transcripts. The guards are unit-tested; real Whisper runs when it and its model exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { activity, cleanTranscript, envelope, FRAME_SEC, speechShare, WHISPER_MODEL, whisperArgs } from "../src/transcript.mjs";
import { createJobQueue } from "../src/jobs.mjs";
import { ensureLayout } from "../src/paths.mjs";
import { searchDirs, which } from "../src/tools.mjs";

const dirs = searchDirs(process.env);
const ffmpeg = which("ffmpeg", dirs);
const ffprobe = which("ffprobe", dirs);
const whisper = which("whisper", dirs);
const model = join(homedir(), ".cache", "whisper", `${WHISPER_MODEL}.pt`);
const say = existsSync("/usr/bin/say") ? "/usr/bin/say" : null;
const skipReal = !ffmpeg || !whisper ? "Whisper or FFmpeg not installed" : !existsSync(model) ? "Whisper model not downloaded" : !say ? "needs macOS say for spoken test audio" : false;
const media = mkdtempSync(join(tmpdir(), "sh-speech-"));

/** dB frames: `pattern` is a function of the frame index. */
const frames = (n, f) => Float32Array.from({ length: n }, (_, i) => f(i));
const pcmTone = (seconds, amp) => {
  const n = seconds * 16000;
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  return new Uint8Array(a.buffer);
};

test("envelope and activity: speech-like sound varies, a steady tone and silence don't", () => {
  const db = envelope(pcmTone(2, 0.1));
  assert.equal(db.length, 100);
  assert.ok(Math.abs(db[50] - -23) < 1, String(db[50])); // RMS of a sine at 0.1 is about −23 dBFS
  assert.equal(activity(db).reduce((a, b) => a + b, 0), 0, "a steady tone is not speech-like");
  assert.equal(activity(frames(100, () => -120)).reduce((a, b) => a + b, 0), 0, "silence is not speech-like");
  // Syllables: loud for 100 ms, quiet for 100 ms.
  const syll = activity(frames(100, (i) => (Math.floor(i / 5) % 2 ? -45 : -20)));
  assert.ok(syll.reduce((a, b) => a + b, 0) >= 45);
  assert.equal(speechShare(syll, 0, 2), syll.reduce((a, b) => a + b, 0) / 100);
  assert.equal(speechShare(syll, 5, 6), 0, "outside the audio");
});

const seg = (over) => ({ start: 0, end: 2, text: " hello there", no_speech_prob: 0.01, avg_logprob: -0.3, compression_ratio: 1.1, words: [{ word: " hello", start: 0.2, end: 0.6, probability: 0.9 }, { word: " there", start: 0.6, end: 1.0, probability: 0.9 }], ...over });

test("guards: text over a tone, repeated text, Whisper's own no-speech rule, past the end", () => {
  const speech = new Uint8Array(500).fill(1); // 10 s of speech-like sound
  const tone = new Uint8Array(500); // 10 s of non-speech
  assert.deepEqual(cleanTranscript({ segments: [seg()] }, speech, 10).segments, [{ start: 0.2, end: 1, text: "hello there", words: [{ w: "hello", s: 0.2, e: 0.6 }, { w: "there", s: 0.6, e: 1 }] }]);
  // The case seen with real Whisper: "Thank you." over a steady tone, no-speech probability 0.
  const ty = cleanTranscript({ segments: [seg({ start: 0, end: 29.98, text: " Thank you.", no_speech_prob: 0, avg_logprob: -0.85, words: [{ word: " Thank", start: 0.98, end: 1.02 }, { word: " you.", start: 1.02, end: 1.04 }] })] }, tone, 20);
  assert.deepEqual(ty.segments, []);
  assert.deepEqual(ty.dropped, [{ start: 0, end: 20, text: "Thank you.", reason: "no speech in the sound" }]);
  assert.equal(cleanTranscript({ segments: [seg({ compression_ratio: 3.1 })] }, speech, 10).dropped[0].reason, "repeated text");
  assert.equal(cleanTranscript({ segments: [seg({ no_speech_prob: 0.9, avg_logprob: -1.4 })] }, speech, 10).dropped[0].reason, "Whisper found no speech");
  assert.equal(cleanTranscript({ segments: [seg({ start: 12, end: 14 })] }, speech, 10).dropped[0].reason, "after the end of the audio");
  // Some words over silence: those words go, the rest stays (Whisper's words, unchanged).
  const half = new Uint8Array(500);
  half.fill(1, 0, Math.round(0.7 / FRAME_SEC));
  const three = seg({ text: " hello there friend", words: [{ word: " hello", start: 0.1, end: 0.3 }, { word: " there", start: 0.3, end: 0.6 }, { word: " friend", start: 4, end: 4.4 }] });
  assert.equal(cleanTranscript({ segments: [three] }, half, 10).segments[0].text, "hello there");
  assert.deepEqual(cleanTranscript(null, speech, 10), { segments: [], dropped: [] });
});

test("Whisper arguments: fixed model folder, word times, no previous-text conditioning, language only if valid", () => {
  const a = whisperArgs({ input: "/w/files/a.mp4", outDir: "/w/tmp/x", modelDir: "/m", language: "en", threads: 4 });
  assert.deepEqual(a.slice(0, 5), ["/w/files/a.mp4", "--model", "large-v3-turbo", "--model_dir", "/m"]);
  assert.ok(a.join(" ").includes("--word_timestamps True --condition_on_previous_text False"));
  assert.deepEqual(a.slice(-2), ["--language", "en"]);
  const q = createJobQueue({ dir: (() => { const d = mkdtempSync(join(tmpdir(), "sh-q-")); ensureLayout(d); return d; })(), tools: { ffmpeg, ffprobe, whisper: null } });
  assert.throws(() => q.add({ id: "t0", input: "a.mp4", kind: "transcribe", options: { language: "en; rm -rf" } }), /Invalid language/);
  assert.throws(() => q.add({ id: "t0", input: "a.mp4", kind: "shell" }), /Unknown job kind/);
});

function speechVideo() {
  const p = join(media, "speech.mp4");
  if (existsSync(p)) return p;
  const aiff = join(media, "s.aiff");
  execFileSync(say, ["-v", "Samantha", "-o", aiff, "Oh my god, did you see that? That was the best play of the whole tournament. Let's go!"]);
  // 3 s of silence, the sentence, then silence; over a moving test picture.
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12", "-f", "lavfi", "-t", "3", "-i", "anullsrc=r=48000:cl=stereo", "-i", aiff, "-filter_complex", "[2]aresample=48000,aformat=channel_layouts=stereo[s];[1][s]concat=n=2:v=0:a=1,apad[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "12", p]);
  return p;
}
function toneVideo() {
  const p = join(media, "tone.mp4");
  if (!existsSync(p)) execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=20", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p]);
  return p;
}
function queueWith(src) {
  const dir = mkdtempSync(join(tmpdir(), "sh-tr-"));
  ensureLayout(dir);
  execFileSync("/bin/cp", [src, join(dir, "files", "in.mp4")]);
  return { dir, q: createJobQueue({ dir, tools: { ffmpeg, ffprobe, whisper } }) };
}
async function waitFor(q, id, ms = 240000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = q.get(id);
    if (["done", "failed", "cancelled"].includes(j?.state)) return j;
    if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("real Whisper: spoken words with their times; nothing invented over a tone", { skip: skipReal, timeout: 600000 }, async () => {
  const a = queueWith(speechVideo());
  a.q.add({ id: "tr1", input: "in.mp4", kind: "transcribe", options: { language: "en" } });
  const j = await waitFor(a.q, "tr1");
  assert.equal(j.state, "done", j.error);
  assert.equal(j.kind, "transcribe");
  assert.match(j.metrics.encoder, /whisper large-v3-turbo/);
  const t = JSON.parse(readFileSync(join(a.dir, "files", j.output.transcript), "utf8"));
  const text = t.segments.map((s) => s.text).join(" ").toLowerCase();
  for (const w of ["did you see that", "best play", "tournament"]) assert.ok(text.includes(w), text);
  assert.ok(t.segments[0].start > 2.3 && t.segments[0].start < 3.6, `speech starts at 3 s, got ${t.segments[0].start}`);
  assert.ok(t.segments.at(-1).end < 9.5);
  assert.ok(t.segments[0].words.length >= 15);
  assert.equal(existsSync(join(a.dir, "files", "in.mp4")), false, "input deleted after use");
  assert.deepEqual(readdirSync(join(a.dir, "tmp")), []);

  const b = queueWith(toneVideo());
  b.q.add({ id: "tr2", input: "in.mp4", kind: "transcribe" });
  const k = await waitFor(b.q, "tr2");
  assert.equal(k.state, "done", k.error);
  const u = JSON.parse(readFileSync(join(b.dir, "files", k.output.transcript), "utf8"));
  assert.deepEqual(u.segments, [], `invented: ${JSON.stringify(u.segments)}`);
  assert.ok(k.notes.includes("No speech was found."));
});

test("real Whisper: cancel stops it and leaves no files", { skip: skipReal, timeout: 300000 }, async () => {
  const a = queueWith(speechVideo());
  a.q.add({ id: "tr3", input: "in.mp4", kind: "transcribe" });
  const end = Date.now() + 60000;
  while (a.q.get("tr3").state !== "transcribing" && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 1500));
  a.q.cancel("tr3");
  assert.equal((await waitFor(a.q, "tr3")).state, "cancelled");
  await new Promise((r) => setTimeout(r, 500));
  const left = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes("whisper") && l.includes(a.dir));
  assert.deepEqual(left, []);
  assert.deepEqual(readdirSync(join(a.dir, "tmp")), []);
  assert.equal(readdirSync(join(a.dir, "files")).filter((n) => n.includes("transcript")).length, 0);
});

test("missing model: a clear message, nothing downloaded", { skip: !ffmpeg ? "no ffmpeg" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sh-tr-"));
  ensureLayout(dir);
  execFileSync("/bin/cp", [toneVideo(), join(dir, "files", "in.mp4")]);
  const q = createJobQueue({ dir, tools: { ffmpeg, ffprobe, whisper: whisper ?? "/usr/bin/false", whisperModelDir: join(dir, "no-models") } });
  q.add({ id: "tr4", input: "in.mp4", kind: "transcribe" });
  const j = await waitFor(q, "tr4", 20000);
  assert.equal(j.state, "failed");
  assert.match(j.error, /large-v3-turbo model isn't on this computer/);
  assert.equal(existsSync(join(dir, "no-models")), false);
});
