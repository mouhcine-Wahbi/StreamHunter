/**
 * The companion's editing queue: one job at a time, each saved to jobs/<id>.json so a crash or a
 * Chrome restart doesn't lose it (interrupted jobs start again from the beginning). FFmpeg runs at
 * lower priority; cancel stops it and removes partial files. CPU time and peak memory are measured.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import { join } from "node:path";
import { checkOutput, checkPlan, expectedDuration, ffmpegArgs, readProbe, TEMPLATE_FFMPEG } from "./plan.mjs";
import { inside, isSafeName } from "./paths.mjs";

export const TERMINAL = new Set(["done", "failed", "cancelled"]);
export const MAX_ATTEMPTS = 2;
class Cancelled extends Error {}

/** "1:02.50" / "0:01.23" / "1-02:03:04" (ps cputime) → milliseconds. */
export function parseCpuTime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(s).trim());
  if (!m) return 0;
  const [, d, h, min, sec] = m;
  return Math.round(((Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min) * 60 + Number(sec)) * 1000);
}

function sample(pid) {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "rss=,time=", "-p", String(pid)], { timeout: 2000 }, (err, out) => {
      if (err) return resolve(null);
      const [rss, time] = out.trim().split(/\s+/);
      resolve({ rssBytes: Number(rss) * 1024, cpuMs: parseCpuTime(time) });
    });
  });
}

export function createJobQueue({ dir, tools, log = () => undefined, emit = () => undefined, nice = 10 }) {
  const jobsDir = join(dir, "jobs");
  const files = join(dir, "files");
  mkdirSync(jobsDir, { recursive: true });
  const jobs = new Map();
  let running = null; // { id, child }

  const save = (job) => {
    const p = join(jobsDir, `${job.id}.json`);
    writeFileSync(p + ".tmp", JSON.stringify(job));
    renameSync(p + ".tmp", p);
  };
  const update = (job, patch) => {
    // A cancelled job never moves to another state (the worker notices and stops).
    if (job.state === "cancelled" && patch.state && patch.state !== "cancelled") throw new Cancelled();
    Object.assign(job, patch, { updated_at: new Date().toISOString() });
    save(job);
    emit({ event: "job", job: publicJob(job) });
    return job;
  };
  const publicJob = (j) => ({ id: j.id, state: j.state, step: j.step, progress: j.progress, error: j.error, attempts: j.attempts, output: j.output, metrics: j.metrics, notes: j.notes, template: j.template });

  // Recovery: anything not finished starts again from the beginning.
  for (const n of readdirSync(jobsDir).filter((x) => x.endsWith(".json"))) {
    try {
      const j = JSON.parse(readFileSync(join(jobsDir, n), "utf8"));
      if (!TERMINAL.has(j.state)) Object.assign(j, { state: "queued", step: "Waiting (restarted after an interruption)", progress: 0 });
      jobs.set(j.id, j);
      save(j);
    } catch {
      log("job_unreadable", { file: n });
    }
  }

  function run(file, args, onLine) {
    return new Promise((resolve) => {
      const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
      try {
        setPriority(child.pid, nice);
      } catch {
        // not fatal
      }
      let err = "";
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        if (onLine) {
          const lines = out.split("\n");
          out = lines.pop();
          lines.forEach(onLine);
        }
      });
      child.stderr.on("data", (d) => (err = (err + d).slice(-8000)));
      child.on("error", (e) => resolve({ code: -1, err: e.message, out, child }));
      child.on("close", (code, signal) => resolve({ code, signal, err, out, child }));
      if (running) running.child = child;
    });
  }

  async function probe(path) {
    const r = await run(tools.ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]);
    if (r.code !== 0) return null;
    try {
      return readProbe(JSON.parse(r.out));
    } catch {
      return null;
    }
  }

  async function process(job) {
    const input = inside(files, job.input);
    const out = join(files, `${job.id}-out.mp4`);
    const thumb = join(files, `${job.id}-thumb.jpg`);
    const partial = join(dir, "tmp", `${job.id}-out.mp4`);
    const started = Date.now();
    running = { id: job.id, child: null };
    try {
      update(job, { state: "probing", step: "Checking the clip", progress: 0, attempts: job.attempts + 1, error: null });
      if (!existsSync(input)) throw new Error("The clip file wasn't received.");
      const info = await probe(input);
      if (!info || !info.width || !info.duration) throw new Error("The clip file is damaged or isn't a video.");
      const problems = checkPlan(job.plan, info);
      if (problems.length) throw new Error(`The edit plan doesn't fit this clip: ${problems.join("; ")}`);
      const want = expectedDuration(job.plan, info);

      update(job, { state: "encoding", step: "Making the vertical Short (FFmpeg)", progress: 0 });
      let peak = 0;
      let cpu = 0;
      const timer = setInterval(async () => {
        const pid = running?.child?.pid;
        const s = pid ? await sample(pid) : null;
        if (s) {
          peak = Math.max(peak, s.rssBytes);
          cpu = Math.max(cpu, s.cpuMs);
        }
      }, 400);
      let lastEmit = 0;
      const r = await run(tools.ffmpeg, ffmpegArgs(job.plan, { ...info, path: input }, partial), (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && want > 0 && Date.now() - lastEmit > 500) {
          lastEmit = Date.now();
          update(job, { progress: Math.min(0.99, Number(m[1]) / 1e6 / want) });
        }
      });
      clearInterval(timer);
      if (job.state === "cancelled") throw new Cancelled();
      if (r.code !== 0) throw new Error(`FFmpeg failed: ${(r.err || r.signal || "unknown error").trim().split("\n").slice(-3).join(" ")}`);

      update(job, { state: "validating", step: "Checking the Short plays correctly", progress: 1 });
      const outInfo = await probe(partial);
      const bad = checkOutput(outInfo, job.plan, info);
      if (bad.length) throw new Error(`The Short didn't pass the checks: ${bad.join("; ")}`);
      const decode = await run(tools.ffmpeg, ["-v", "error", "-xerror", "-i", partial, "-f", "null", "-"]);
      if (decode.code !== 0 || decode.err.trim()) throw new Error(`The Short doesn't decode cleanly: ${decode.err.trim().slice(0, 300)}`);
      const at = Math.min(Math.max(0, job.plan.thumbnailAt ?? outInfo.duration / 3), Math.max(0, outInfo.duration - 0.1));
      await run(tools.ffmpeg, ["-v", "error", "-y", "-ss", String(at), "-i", partial, "-frames:v", "1", "-vf", "scale=360:640", "-q:v", "4", thumb]);
      renameSync(partial, out);
      update(job, {
        state: "done",
        step: "Ready",
        progress: 1,
        output: { video: `${job.id}-out.mp4`, thumbnail: existsSync(thumb) ? `${job.id}-thumb.jpg` : null, width: outInfo.width, height: outInfo.height, duration: Math.round(outInfo.duration * 100) / 100, size: statSync(out).size, has_audio: outInfo.hasAudio },
        metrics: { wall_ms: Date.now() - started, cpu_ms: cpu, peak_rss_bytes: peak, encoder: job.plan.encoder === "videotoolbox" ? "h264_videotoolbox" : "libx264" },
        notes: [...(job.plan.notes ?? []), ...(info.hasAudio ? (job.plan.audio?.loudnorm ? ["Loudness normalized to about −14 LUFS."] : []) : ["The clip has no audio."])],
      });
      rmSync(input, { force: true });
    } catch (e) {
      rmSync(partial, { force: true });
      if (job.state === "cancelled") rmSync(thumb, { force: true });
      if (job.state !== "cancelled") update(job, { state: "failed", step: "Failed", error: e.message });
      if (!(e instanceof Cancelled)) log("job_failed", { id: job.id, error: e.message });
    } finally {
      running = null;
    }
  }

  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const next = [...jobs.values()].filter((j) => j.state === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        if (!next) break;
        if (next.attempts >= MAX_ATTEMPTS) {
          update(next, { state: "failed", step: "Failed", error: next.error ?? "Stopped after repeated interruptions." });
          continue;
        }
        await process(next);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    /** Adds a job; the same id is never added twice (duplicates return the existing job). */
    add({ id, input, plan }) {
      if (!isSafeName(id) || !isSafeName(input)) throw new Error("Invalid job id or file name");
      const existing = jobs.get(id);
      if (existing && existing.state !== "failed" && existing.state !== "cancelled") return publicJob(existing);
      const job = { id, input, plan, template: plan?.template ?? TEMPLATE_FFMPEG, state: "queued", step: "Waiting", progress: 0, attempts: 0, error: null, output: null, metrics: null, notes: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      jobs.set(id, job);
      save(job);
      void pump();
      return publicJob(job);
    },
    get: (id) => (jobs.has(id) ? publicJob(jobs.get(id)) : null),
    list: () => [...jobs.values()].map(publicJob),
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (TERMINAL.has(job.state)) return publicJob(job);
      update(job, { state: "cancelled", step: "Cancelled", progress: 0 });
      if (running?.id === id) running.child?.kill("SIGTERM");
      return publicJob(job);
    },
    /** Forget a finished job and delete its files (after the extension imported the output). */
    remove(id) {
      const job = jobs.get(id);
      if (!job) return false;
      if (running?.id === id) return false;
      for (const n of [job.input, job.output?.video, job.output?.thumbnail]) if (n && isSafeName(n)) rmSync(join(files, n), { force: true });
      rmSync(join(jobsDir, `${id}.json`), { force: true });
      jobs.delete(id);
      return true;
    },
    resume: () => void pump(),
    get busy() {
      return running !== null;
    },
  };
}
