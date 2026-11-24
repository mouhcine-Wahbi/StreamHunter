// Real FFmpeg tests: generated 1920×1080 videos, a damaged file, cancel, recovery and duplicates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlan, pathExpr, readProbe, filterGraph } from "../src/plan.mjs";
import { createJobQueue, parseCpuTime } from "../src/jobs.mjs";
import { ensureLayout } from "../src/paths.mjs";
import { searchDirs, which } from "../src/tools.mjs";
import { browserPath } from "../src/render.mjs";

const dirs = searchDirs(process.env);
const ffmpeg = which("ffmpeg", dirs);
const ffprobe = which("ffprobe", dirs);
const skip = !ffmpeg || !ffprobe ? "ffmpeg not installed" : false;
const media = mkdtempSync(join(tmpdir(), "sh-media-"));
const tools = { ffmpeg, ffprobe };

function make(name, { seconds = 6, audio = true } = {}) {
  const p = join(media, name);
  if (!existsSync(p)) {
    const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${seconds}`];
    if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac");
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-shortest", p);
    execFileSync(ffmpeg, args);
  }
  return p;
}
function probe(p) {
  return readProbe(JSON.parse(execFileSync(ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", p], { encoding: "utf8" })));
}
function workDir(src) {
  const dir = mkdtempSync(join(tmpdir(), "sh-jobs-"));
  ensureLayout(dir);
  if (src) copyFileSync(src, join(dir, "files", "in.mp4"));
  return dir;
}
const single = (over = {}) => ({ version: 1, template: "ffmpeg_clean_v1", trim: { start: 0, end: null }, output: { width: 1080, height: 1920, maxFps: 60 }, panels: [{ sx: 656, sy: 0, sw: 608, sh: 1080, dy: 0, dh: 1920 }], audio: { loudnorm: true }, encoder: "x264", ...over });
const stacked = (over = {}) => single({ panels: [{ sx: 1440, sy: 0, sw: 480, sh: 360, dy: 0, dh: 720 }, { sx: 480, sy: 0, sw: 960, sh: 1080, dy: 720, dh: 1200 }], ...over });
async function waitFor(q, id, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = q.get(id);
    if (["done", "failed", "cancelled"].includes(j?.state)) return j;
    if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("plan checks and the action-path expression", () => {
  const input = { width: 1920, height: 1080, duration: 10, fps: 30 };
  assert.deepEqual(checkPlan(single(), input), []);
  assert.deepEqual(checkPlan(stacked(), input), []);
  assert.ok(checkPlan(single({ panels: [{ sx: 1500, sy: 0, sw: 608, sh: 1080, dy: 0, dh: 1920 }] }), input).some((x) => x.includes("outside")));
  assert.ok(checkPlan(single({ trim: { start: 11, end: null } }), input).some((x) => x.includes("after the end")));
  assert.ok(checkPlan(single({ encoder: "nvenc" }), input).includes("Unknown encoder"));
  assert.ok(checkPlan({ ...stacked(), panels: [stacked().panels[0]] }, input).includes("Panels must fill the 1920 px height"));
  assert.deepEqual(checkPlan({ version: 2 }, input), ["Unsupported plan version"]);
  const e = pathExpr([[0, 100], [2, 300], [4, 300]], 1312);
  assert.equal(e, "clip(if(lt(t,0),100,if(lt(t,2),100+200*(t-0)/2,if(lt(t,4),300,300))),0,1312)");
  // Path times are shifted by the trim (the filter clock starts at the trim start).
  assert.match(filterGraph(single({ trim: { start: 2, end: null }, panels: [{ ...single().panels[0], sxPath: [[2, 100], [4, 500]] }] }), input), /lt\(t,0\),100.*100\+400\*\(t-0\)\/2/);
  assert.equal(parseCpuTime("1:02.50"), 62500);
  assert.equal(parseCpuTime("1-02:03:04"), 93784000);
});

test("single panel with an action path: 1080×1920 H.264 + AAC, decodes, thumbnail, metrics", { skip }, async () => {
  const dir = workDir(make("a.mp4"));
  const events = [];
  const q = createJobQueue({ dir, tools, emit: (e) => events.push(e) });
  q.add({ id: "j1", input: "in.mp4", plan: single({ panels: [{ ...single().panels[0], sxPath: [[0, 0], [3, 1312], [6, 600]] }] }) });
  const j = await waitFor(q, "j1");
  assert.equal(j.state, "done", j.error);
  const out = probe(join(dir, "files", j.output.video));
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1920);
  assert.equal(out.videoCodec, "h264");
  assert.equal(out.audioCodec, "aac");
  assert.ok(Math.abs(out.duration - 6) < 0.6);
  assert.ok(existsSync(join(dir, "files", j.output.thumbnail)));
  assert.ok(!existsSync(join(dir, "files", "in.mp4")), "input removed after success");
  assert.ok(j.metrics.wall_ms > 0 && j.metrics.encoder === "libx264");
  assert.ok(j.notes.some((n) => n.includes("Loudness")));
  assert.deepEqual(readdirSync(join(dir, "tmp")), []);
  const states = events.map((e) => e.job.state);
  for (const s of ["queued", "probing", "encoding", "validating", "done"].slice(1)) assert.ok(states.includes(s), s);
});

test("two stacked panels with a trim and the hardware encoder (if present)", { skip }, async () => {
  const dir = workDir(make("a.mp4"));
  const q = createJobQueue({ dir, tools });
  const hasVT = execFileSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes("h264_videotoolbox");
  q.add({ id: "j2", input: "in.mp4", plan: stacked({ trim: { start: 1, end: 4.5 }, encoder: hasVT ? "videotoolbox" : "x264" }) });
  const j = await waitFor(q, "j2");
  assert.equal(j.state, "done", j.error);
  assert.equal(j.output.width, 1080);
  assert.equal(j.output.height, 1920);
  assert.ok(Math.abs(j.output.duration - 3.5) < 0.6, String(j.output.duration));
});

test("a video without sound stays silent; a damaged file fails with a clear message", { skip }, async () => {
  const dir = workDir(make("silent.mp4", { audio: false }));
  writeFileSync(join(dir, "files", "bad.mp4"), Buffer.alloc(200_000, 7));
  const q = createJobQueue({ dir, tools });
  q.add({ id: "s1", input: "in.mp4", plan: single() });
  q.add({ id: "b1", input: "bad.mp4", plan: single() });
  const s = await waitFor(q, "s1");
  assert.equal(s.state, "done", s.error);
  assert.equal(s.output.has_audio, false);
  assert.ok(s.notes.includes("The clip has no audio."));
  const b = await waitFor(q, "b1");
  assert.equal(b.state, "failed");
  assert.match(b.error, /damaged/);
});

test("cancel stops FFmpeg and leaves no partial output; duplicates return the existing job", { skip }, async () => {
  const dir = workDir(make("long.mp4", { seconds: 40 }));
  const q = createJobQueue({ dir, tools });
  const first = q.add({ id: "c1", input: "in.mp4", plan: single() });
  assert.equal(q.add({ id: "c1", input: "in.mp4", plan: single() }).id, first.id);
  assert.equal(q.list().length, 1);
  const end = Date.now() + 20000;
  while (q.get("c1").state !== "encoding" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 300));
  q.cancel("c1");
  const j = await waitFor(q, "c1");
  assert.equal(j.state, "cancelled");
  // "cancelled" is reported at once; FFmpeg then exits and the worker removes the partial file.
  for (let i = 0; i < 200 && q.busy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(q.busy, false);
  assert.deepEqual(readdirSync(join(dir, "tmp")), []);
  assert.ok(!existsSync(join(dir, "files", "c1-out.mp4")));
  // A cancelled job can be started again with the same id.
  assert.ok(["queued", "probing"].includes(q.add({ id: "c1", input: "in.mp4", plan: single({ trim: { start: 0, end: 2 } }) }).state));
  assert.equal((await waitFor(q, "c1")).state, "done");
});

test("an interrupted job is picked up again when the companion restarts", { skip }, async () => {
  const dir = workDir(make("a.mp4"));
  const now = new Date().toISOString();
  writeFileSync(join(dir, "jobs", "r1.json"), JSON.stringify({ id: "r1", input: "in.mp4", plan: single({ trim: { start: 0, end: 2 } }), template: "ffmpeg_clean_v1", state: "encoding", step: "x", progress: 0.4, attempts: 1, error: null, output: null, metrics: null, notes: [], created_at: now, updated_at: now }));
  writeFileSync(join(dir, "jobs", "broken.json"), "{not json");
  const q = createJobQueue({ dir, tools });
  assert.equal(q.get("r1").state, "queued");
  q.resume();
  const j = await waitFor(q, "r1");
  assert.equal(j.state, "done", j.error);
  assert.equal(j.attempts, 2);
  assert.ok(q.remove("r1"));
  assert.ok(!existsSync(join(dir, "files", "r1-out.mp4")));
});

// ── 4.3 Remotion template ────────────────────────────────────────────────────────────────────────
import { motionProps } from "../src/plan.mjs";
import { detectRemotion } from "../src/tools.mjs";
const remotionSkip = skip || (!detectRemotion().ok ? "Remotion not set up" : false);
const withMotion = (over = {}) => stacked({ template: "remotion_clean_gaming_v1", motion: { zoomAt: 3, zoomScale: 1.12, fadeIn: 0.25 }, ...over });
function grayFrame(p, t) {
  return execFileSync(ffmpeg, ["-v", "error", "-ss", String(t), "-i", p, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"], { maxBuffer: 16e6 });
}
const diff = (a, b, from, to) => {
  let s = 0, n = 0;
  for (let i = from * 1080; i < to * 1080; i += 97) (s += Math.abs(a[i] - b[i])), n++;
  return s / n;
};

test("motion plans: zoom limited to 1.15×, captions only with the template; props from the base video", () => {
  const input = { width: 1920, height: 1080, duration: 10, fps: 30 };
  assert.deepEqual(checkPlan(withMotion(), input), []);
  assert.ok(checkPlan(withMotion({ motion: { zoomAt: 3, zoomScale: 1.5, fadeIn: 0 } }), input).some((x) => x.includes("Zoom")));
  assert.ok(checkPlan(stacked({ captions: [{ start: 0, end: 1, text: "hi" }] }), input).includes("Captions need the Remotion template"));
  assert.ok(checkPlan(withMotion({ captions: [{ start: 2, end: 1, text: "x" }] }), input).includes("Invalid captions"));
  const p = motionProps(withMotion(), { duration: 6, fps: 30 });
  assert.equal(p.durationInFrames, 180);
  assert.equal(p.splitY, 720);
  assert.deepEqual(p.zoom, { frames: [78, 90, 126, 138], scale: 1.12 });
  assert.equal(p.fadeInFrames, 8);
  // A zoom at the very end is clamped to the Short.
  assert.equal(motionProps(withMotion({ motion: { zoomAt: 5.9, zoomScale: 1.1, fadeIn: 0 } }), { duration: 6, fps: 30 }).zoom.frames[3], 179);
  assert.equal(motionProps(withMotion({ motion: { zoomAt: null, zoomScale: 1.1, fadeIn: 0 } }), { duration: 6, fps: 30 }).zoom, null);
});

test("Remotion template: punch-in on the gameplay only, facecam untouched, valid 1080×1920 H.264 + AAC", { skip: remotionSkip, timeout: 240000 }, async () => {
  const dir = workDir(make("a.mp4"));
  const q = createJobQueue({ dir, tools: { ...tools, node: process.execPath, remotion: true } });
  q.add({ id: "m1", input: "in.mp4", plan: withMotion({ encoder: "x264" }) });
  const j = await waitFor(q, "m1", 240000);
  assert.equal(j.state, "done", j.error);
  assert.match(j.metrics.encoder, /Remotion/);
  assert.ok(j.metrics.peak_rss_bytes > 100e6, "the browser's memory is counted");
  const out = join(dir, "files", j.output.video);
  const info = probe(out);
  assert.deepEqual([info.width, info.height, info.videoCodec, info.audioCodec], [1080, 1920, "h264", "aac"]);
  assert.ok(Math.abs(info.duration - 6) < 0.6);
  // Compare against the same plan without motion (FFmpeg only).
  const ref = workDir(make("a.mp4"));
  const q2 = createJobQueue({ dir: ref, tools });
  q2.add({ id: "r1", input: "in.mp4", plan: stacked({ encoder: "x264" }) });
  const rj = await waitFor(q2, "r1");
  const refOut = join(ref, "files", rj.output.video);
  const [a1, b1] = [grayFrame(out, 1.5), grayFrame(refOut, 1.5)];
  const [a3, b3] = [grayFrame(out, 3.3), grayFrame(refOut, 3.3)];
  assert.ok(diff(a1, b1, 760, 1920) < 4, `no zoom before the peak (${diff(a1, b1, 760, 1920)})`);
  assert.ok(diff(a3, b3, 760, 1920) > 8, `zoomed at the peak (${diff(a3, b3, 760, 1920)})`);
  assert.ok(diff(a3, b3, 0, 700) < 4, `facecam not zoomed (${diff(a3, b3, 0, 700)})`);
  assert.deepEqual(readdirSync(join(dir, "tmp")), []);
});

test("without Remotion the Short is still made (no zoom), with a note saying why", { skip }, async () => {
  const dir = workDir(make("a.mp4"));
  const q = createJobQueue({ dir, tools: { ...tools, node: process.execPath, remotion: false } });
  q.add({ id: "f1", input: "in.mp4", plan: withMotion({ encoder: "x264", trim: { start: 0, end: 2 } }) });
  const j = await waitFor(q, "f1");
  assert.equal(j.state, "done", j.error);
  assert.ok(j.notes.some((n) => n.includes("Remotion isn't set up")));
  assert.doesNotMatch(j.metrics.encoder, /Remotion/);
});

test("cancel during the Remotion render stops it and its browser, and leaves no files", { skip: remotionSkip, timeout: 240000 }, async () => {
  const count = () => {
    try {
      return execFileSync("/usr/bin/pgrep", ["-f", "chrome-headless-shell"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const before = count();
  const dir = workDir(make("long.mp4", { seconds: 40 }));
  const q = createJobQueue({ dir, tools: { ...tools, node: process.execPath, remotion: true } });
  q.add({ id: "mc", input: "in.mp4", plan: withMotion({ encoder: "videotoolbox" }) });
  const end = Date.now() + 120000;
  while (!(q.get("mc").state === "rendering" && q.get("mc").progress > 0.4) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.equal(q.get("mc").state, "rendering");
  q.cancel("mc");
  assert.equal((await waitFor(q, "mc")).state, "cancelled");
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(count() <= before, `headless browsers left: ${count()} (before ${before})`);
  assert.deepEqual(readdirSync(join(dir, "tmp")), []);
});

test("Remotion's browser is found from the companion folder whatever the current folder (no second download)", { skip: remotionSkip }, () => {
  const p = browserPath();
  assert.ok(p && p.includes(join("node_modules", ".remotion")), p);
  const cwd = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.equal(browserPath(), p);
    assert.equal(detectRemotion().ok, true);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(browserPath(tmpdir()), null);
});
