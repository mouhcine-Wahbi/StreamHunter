/**
 * The companion's editing queue: one job at a time, each saved to jobs/<id>.json so a crash or a
 * Chrome restart doesn't lose it (interrupted jobs start again from the beginning). FFmpeg runs at
 * lower priority; cancel stops it and removes partial files. CPU time and peak memory are measured.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, setPriority } from "node:os";
import { dirname, join } from "node:path";
import { activity, cleanTranscript, envelope, WHISPER_MODEL, whisperArgs } from "./transcript.mjs";
import { checkOutput, checkPlan, expectedDuration, ffmpegArgs, motionProps, readProbe, TEMPLATE_FFMPEG } from "./plan.mjs";
import { fileURLToPath } from "node:url";

const RENDER_WORKER = fileURLToPath(new URL("./render.mjs", import.meta.url));
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

/** Memory and CPU time of a process and all its descendants (FFmpeg, or Remotion and its headless browser). */
export function sampleTree(pid) {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,rss=,time="], { timeout: 2000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return resolve(null);
      const rows = out.trim().split("\n").map((l) => l.trim().split(/\s+/));
      const kids = new Map();
      for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
      const tree = new Set([String(pid)]);
      const stack = [String(pid)];
      while (stack.length) for (const k of kids.get(stack.pop()) ?? []) if (!tree.has(k)) (tree.add(k), stack.push(k));
      let rssBytes = 0;
      const cpu = {};
      for (const [p, , rss, time] of rows)
        if (tree.has(p)) {
          rssBytes += Number(rss) * 1024;
          cpu[p] = parseCpuTime(time);
        }
      resolve({ rssBytes, cpu });
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
  const publicJob = (j) => ({ id: j.id, kind: j.kind ?? "edit", state: j.state, step: j.step, progress: j.progress, error: j.error, attempts: j.attempts, output: j.output, metrics: j.metrics, notes: j.notes, template: j.template });

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

  function run(file, args, onLine, { onErr, env, raw } = {}) {
    return new Promise((resolve) => {
      // Own process group, so cancel stops the program and everything it started (Remotion's browser).
      const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: dir, env: env ?? process.env });
      try {
        setPriority(child.pid, nice);
      } catch {
        // not fatal
      }
      let err = "";
      let out = "";
      const chunks = [];
      child.stdout.on("data", (d) => {
        if (raw) return void chunks.push(d);
        out += d;
        if (onLine) {
          const lines = out.split("\n");
          out = lines.pop();
          lines.forEach(onLine);
        }
      });
      child.stderr.on("data", (d) => {
        err = (err + d).slice(-8000);
        onErr?.(String(d));
      });
      child.on("error", (e) => resolve({ code: -1, err: e.message, out, child }));
      child.on("close", (code, signal) => resolve({ code, signal, err, out, child, data: raw ? Buffer.concat(chunks) : null }));
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

  async function work(job) {
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

      const motion = Boolean(job.plan.motion);
      const remotion = motion && tools.remotion;
      const share = remotion ? 0.35 : 0.99; // part of the progress bar for the FFmpeg step
      update(job, { state: "encoding", step: "Making the vertical Short (FFmpeg)", progress: 0 });
      let peak = 0;
      const cpuByPid = {};
      const timer = setInterval(async () => {
        const pid = running?.child?.pid;
        const s = pid ? await sampleTree(pid) : null;
        if (s) {
          peak = Math.max(peak, s.rssBytes);
          for (const [p, ms] of Object.entries(s.cpu)) cpuByPid[p] = Math.max(cpuByPid[p] ?? 0, ms);
        }
      }, 400);
      let lastEmit = 0;
      const r = await run(tools.ffmpeg, ffmpegArgs(job.plan, { ...info, path: input }, partial), (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && want > 0 && Date.now() - lastEmit > 500) {
          lastEmit = Date.now();
          update(job, { progress: Math.min(share, (Number(m[1]) / 1e6 / want) * share) });
        }
      });
      if (job.state === "cancelled") {
        clearInterval(timer);
        throw new Cancelled();
      }
      if (r.code !== 0) {
        clearInterval(timer);
        throw new Error(`FFmpeg failed: ${(r.err || r.signal || "unknown error").trim().split("\n").slice(-3).join(" ")}`);
      }
      const extraNotes = [];
      let engine = job.plan.encoder === "videotoolbox" ? "h264_videotoolbox" : "libx264";
      if (motion && !remotion) extraNotes.push("Remotion isn't set up in the companion, so this Short has no zoom or opening fade (run the installer again).");
      if (remotion) {
        update(job, { state: "rendering", step: "Adding the zoom and opening (Remotion)", progress: share });
        const base = await probe(partial);
        const rendered = join(dir, "tmp", `${job.id}-render.mp4`);
        const spec = join(dir, "tmp", `${job.id}-render.json`);
        writeFileSync(spec, JSON.stringify({ workDir: dir, input: partial, output: rendered, props: motionProps(job.plan, base) }));
        let workerError = null;
        const rr = await run(tools.node, [RENDER_WORKER, spec], (line) => {
          try {
            const m = JSON.parse(line);
            if (typeof m.progress === "number" && Date.now() - lastEmit > 500) {
              lastEmit = Date.now();
              update(job, { progress: Math.min(0.97, share + m.progress * (0.97 - share)) });
            }
            if (m.error) workerError = m.error;
          } catch {
            // not a progress line
          }
        });
        rmSync(spec, { force: true });
        if (job.state === "cancelled") {
          clearInterval(timer);
          rmSync(rendered, { force: true });
          throw new Cancelled();
        }
        if (rr.code !== 0 || !existsSync(rendered)) {
          clearInterval(timer);
          log("render_failed", { id: job.id, code: rr.code, signal: rr.signal ?? null, stderr: (rr.err || "").slice(-4000) });
          rmSync(rendered, { force: true });
          throw new Error(`Remotion failed: ${workerError ?? (rr.err || "unknown error").trim().split("\n").slice(-2).join(" ")}`);
        }
        // Same streams, index at the front so players start right away.
        const fin = await run(tools.ffmpeg, ["-v", "error", "-y", "-i", rendered, "-c", "copy", "-movflags", "+faststart", partial]);
        rmSync(rendered, { force: true });
        if (fin.code !== 0) {
          clearInterval(timer);
          throw new Error(`FFmpeg couldn't finish the Short: ${fin.err.trim().slice(0, 200)}`);
        }
        engine = `${engine} + Remotion`;
      }
      clearInterval(timer);
      const cpu = Object.values(cpuByPid).reduce((a, b) => a + b, 0);

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
        metrics: { wall_ms: Date.now() - started, cpu_ms: cpu, peak_rss_bytes: peak, encoder: engine },
        notes: [...(job.plan.notes ?? []), ...extraNotes, ...(info.hasAudio ? (job.plan.audio?.loudnorm ? ["Loudness normalized to about −14 LUFS."] : []) : ["The clip has no audio."])],
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

  /** Whisper's model folder (the CLI's default); the model is never downloaded by the companion. */
  const modelDir = tools.whisperModelDir ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "whisper");

  async function transcribe(job) {
    const input = inside(files, job.input);
    const outDir = join(dir, "tmp", `${job.id}-whisper`);
    const result = join(files, `${job.id}-transcript.json`);
    const started = Date.now();
    running = { id: job.id, child: null };
    let peak = 0;
    const cpuByPid = {};
    const timer = setInterval(async () => {
      const pid = running?.child?.pid;
      const s = pid ? await sampleTree(pid) : null;
      if (s) {
        peak = Math.max(peak, s.rssBytes);
        for (const [p, ms] of Object.entries(s.cpu)) cpuByPid[p] = Math.max(cpuByPid[p] ?? 0, ms);
      }
    }, 400);
    try {
      update(job, { state: "probing", step: "Checking the audio", progress: 0, attempts: job.attempts + 1, error: null });
      if (!tools.whisper) throw new Error("Whisper isn't installed. Install it with Homebrew: brew install openai-whisper");
      if (!existsSync(join(modelDir, `${WHISPER_MODEL}.pt`)))
        throw new Error(`Whisper's ${WHISPER_MODEL} model isn't on this computer yet (about 1.6 GB). Download it once in Terminal: whisper --model ${WHISPER_MODEL} <any audio file>`);
      if (!existsSync(input)) throw new Error("The file wasn't received.");
      const info = await probe(input);
      if (!info || !info.duration) throw new Error("The file is damaged or isn't audio or video.");
      const finish = (data, notes) => {
        writeFileSync(result, JSON.stringify(data));
        update(job, {
          state: "done",
          step: "Ready",
          progress: 1,
          output: { transcript: `${job.id}-transcript.json`, language: data.language, segments: data.segments.length, dropped: data.dropped.length, duration: data.duration },
          metrics: { wall_ms: Date.now() - started, cpu_ms: Object.values(cpuByPid).reduce((a, b) => a + b, 0), peak_rss_bytes: peak, encoder: `whisper ${WHISPER_MODEL}` },
          notes,
        });
        rmSync(input, { force: true });
      };
      if (!info.hasAudio) return finish({ model: WHISPER_MODEL, language: null, duration: info.duration, segments: [], dropped: [] }, ["The file has no audio, so there is no transcript."]);

      update(job, { state: "analyzing", step: "Measuring where the sound is speech-like", progress: 0.02 });
      const pcm = await run(tools.ffmpeg, ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], null, { raw: true });
      if (job.state === "cancelled") throw new Cancelled();
      if (pcm.code !== 0) throw new Error(`FFmpeg couldn't read the audio: ${pcm.err.trim().slice(0, 200)}`);
      const act = activity(envelope(pcm.data));

      update(job, { state: "transcribing", step: `Transcribing on this computer (Whisper ${WHISPER_MODEL})`, progress: 0.05 });
      mkdirSync(outDir, { recursive: true });
      // Whisper calls FFmpeg itself: Chrome starts the companion with a minimal PATH.
      const env = { ...process.env, PATH: `${dirname(tools.ffmpeg)}:${process.env.PATH ?? "/usr/bin:/bin"}` };
      let lastEmit = 0;
      const threads = Math.max(1, Math.floor(availableParallelism() / 2));
      const w = await run(tools.whisper, whisperArgs({ input, outDir, modelDir, language: job.options?.language ?? null, threads }), null, {
        env,
        onErr: (chunk) => {
          const m = [...chunk.matchAll(/(\d+)%\|/g)].at(-1);
          if (m && Date.now() - lastEmit > 500) {
            lastEmit = Date.now();
            update(job, { progress: Math.min(0.95, 0.05 + (Number(m[1]) / 100) * 0.9) });
          }
        },
      });
      if (job.state === "cancelled") throw new Cancelled();
      const name = readdirSync(outDir).find((n) => n.endsWith(".json"));
      if (w.code !== 0 || !name) throw new Error(`Whisper failed: ${(w.err || w.signal || "unknown error").trim().split("\n").filter((l) => !/%\|/.test(l)).slice(-2).join(" ")}`);
      const raw = JSON.parse(readFileSync(join(outDir, name), "utf8"));
      const clean = cleanTranscript(raw, act, info.duration);
      const notes = [];
      if (clean.dropped.length) notes.push(`${clean.dropped.length} piece${clean.dropped.length === 1 ? "" : "s"} of text dropped: no speech in the sound there (Whisper can invent text over music, noise or silence).`);
      if (!clean.segments.length) notes.push("No speech was found.");
      finish({ model: WHISPER_MODEL, language: raw.language ?? null, duration: info.duration, ...clean }, notes);
    } catch (e) {
      rmSync(result, { force: true });
      if (job.state !== "cancelled") update(job, { state: "failed", step: "Failed", error: e.message });
      if (!(e instanceof Cancelled)) log("job_failed", { id: job.id, error: e.message });
    } finally {
      clearInterval(timer);
      rmSync(outDir, { recursive: true, force: true });
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
        await (next.kind === "transcribe" ? transcribe(next) : work(next));
      }
    } finally {
      pumping = false;
    }
  }

  return {
    /** Adds a job; the same id is never added twice (duplicates return the existing job). */
    add({ id, input, plan, kind = "edit", options = null }) {
      if (!isSafeName(id) || !isSafeName(input)) throw new Error("Invalid job id or file name");
      if (kind !== "edit" && kind !== "transcribe") throw new Error("Unknown job kind");
      if (kind === "transcribe" && options?.language != null && !/^[a-z]{2,3}$/.test(options.language)) throw new Error("Invalid language");
      const existing = jobs.get(id);
      if (existing && existing.state !== "failed" && existing.state !== "cancelled") return publicJob(existing);
      const job = { id, kind, input, plan: kind === "edit" ? plan : null, options: kind === "transcribe" ? { language: options?.language ?? null } : null, template: kind === "edit" ? (plan?.template ?? TEMPLATE_FFMPEG) : null, state: "queued", step: "Waiting", progress: 0, attempts: 0, error: null, output: null, metrics: null, notes: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
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
      if (running?.id === id && running.child?.pid) {
        try {
          process.kill(-running.child.pid, "SIGTERM");
        } catch {
          running.child.kill("SIGTERM");
        }
      }
      return publicJob(job);
    },
    /** Forget a finished job and delete its files (after the extension imported the output). */
    remove(id) {
      const job = jobs.get(id);
      if (!job) return false;
      if (running?.id === id) return false;
      for (const n of [job.input, job.output?.video, job.output?.thumbnail, job.output?.transcript]) if (n && isSafeName(n)) rmSync(join(files, n), { force: true });
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
