#!/usr/bin/env node
/**
 * StreamHunter Companion: a native messaging host Chrome starts for the StreamHunter extension.
 * It only answers fixed requests, works only inside its work folder, and exits when Chrome
 * disconnects. Stdout is reserved for Chrome; logs go to <work folder>/logs/companion.log.
 */
import { readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDecoder, encode } from "./native.mjs";
import { ensureLayout, inside, workDir } from "./paths.mjs";
import { createLog } from "./log.mjs";
import { atLeast, detectTools } from "./tools.mjs";
import { freeBytes, startFileServer } from "./server.mjs";
import { createJobQueue } from "./jobs.mjs";

export const VERSION = "0.4.0";
export const PROTOCOL = 1;

/** "chrome-extension://<id>/" (manifest form) → "chrome-extension://<id>" (HTTP Origin form). */
export const originOf = (s) => String(s).replace(/\/+$/, "");

export function readConfig(dir) {
  try {
    const c = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return { allowed: (c.allowed_origins ?? []).map(originOf) };
  } catch {
    return { allowed: [] };
  }
}

function usedBytes(dir) {
  let total = 0;
  for (const sub of ["files", "jobs", "tmp"]) {
    for (const n of readdirSync(join(dir, sub))) {
      const st = statSync(join(dir, sub, n), { throwIfNoEntry: false });
      if (st?.isFile()) total += st.size;
    }
  }
  return total;
}

export function createCompanion({ dir, caller, write, exit, env = process.env }) {
  ensureLayout(dir);
  const log = createLog(dir);
  const { allowed } = readConfig(dir);
  const origin = caller ? originOf(caller) : null;
  let files = null;
  let tools = null;
  let queue = null;
  const jobsReady = async () => {
    tools ??= await detectTools(env);
    if (!tools.ffmpeg.ok || !tools.ffprobe.ok) throw new Error("FFmpeg and FFprobe are needed for editing. Install them with Homebrew: brew install ffmpeg");
    queue ??= createJobQueue({ dir, tools: { ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path, node: process.execPath, remotion: Boolean(tools.remotion?.ok), whisper: tools.whisper?.found && atLeast(tools.whisper.version, tools.whisper.min) ? tools.whisper.path : null }, log, emit: write });
    return queue;
  };

  const handle = async (msg) => {
    switch (msg.type) {
      case "hello": {
        files ??= await startFileServer({ dir, origins: allowed, log });
        tools ??= await detectTools(env);
        if (tools.ffmpeg.ok && tools.ffprobe.ok) (await jobsReady()).resume();
        return { version: VERSION, protocol: PROTOCOL, pid: process.pid, node: process.version, port: files.port, token: files.token, work_dir: dir, free_bytes: freeBytes(dir), used_bytes: usedBytes(dir), tools };
      }
      case "tools":
        tools = await detectTools(env);
        return { tools };
      case "disk":
        return { work_dir: dir, free_bytes: freeBytes(dir), used_bytes: usedBytes(dir) };
      case "files/delete":
        rmSync(inside(join(dir, "files"), msg.name), { force: true });
        return { deleted: msg.name };
      case "edit/start":
        return (await jobsReady()).add({ id: msg.id_job, input: msg.input, plan: msg.plan });
      case "transcribe/start":
        return (await jobsReady()).add({ id: msg.id_job, input: msg.input, kind: "transcribe", options: { language: msg.language ?? null } });
      case "jobs/get":
        return (await jobsReady()).get(msg.id_job);
      case "jobs/list":
        return (await jobsReady()).list();
      case "jobs/cancel":
        return (await jobsReady()).cancel(msg.id_job);
      case "jobs/remove":
        return { removed: (await jobsReady()).remove(msg.id_job) };
      case "shutdown":
        setImmediate(() => exit(0));
        return { bye: true };
      default:
        throw new Error(`Unknown request: ${String(msg.type)}`);
    }
  };

  const onMessage = async (msg) => {
    const id = msg && typeof msg === "object" ? msg.id : undefined;
    if (!origin || !allowed.includes(origin)) {
      write({ id, ok: false, error: "This extension isn't allowed to use the companion. Run the installer again with its ID." });
      return;
    }
    try {
      write({ id, ok: true, data: await handle(msg ?? {}) });
    } catch (e) {
      log("request_failed", { type: msg?.type, error: e.message });
      write({ id, ok: false, error: e.message });
    }
  };

  log("start", { version: VERSION, caller: origin, allowed: allowed.length });
  return {
    feed: createDecoder(onMessage, (e) => {
      log("bad_message", { error: e.message });
      write({ ok: false, error: e.message });
    }),
    close: () => {
      files?.server.close();
      log("stop");
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/main.mjs");
if (isMain) {
  // Chrome passes the caller's origin ("chrome-extension://<id>/") as the first argument.
  const c = createCompanion({
    dir: workDir(),
    caller: process.argv.find((a) => a.startsWith("chrome-extension://")) ?? null,
    write: (m) => process.stdout.write(encode(m)),
    exit: (code) => process.exit(code),
  });
  process.stdin.on("data", c.feed);
  process.stdin.on("end", () => {
    c.close();
    process.exit(0);
  });
}
