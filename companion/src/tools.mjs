/**
 * Finds the local tools and their versions. Chrome starts the companion with a minimal PATH, so the
 * usual Homebrew folders are searched too. Commands run with execFile (no shell) and a timeout.
 */
import { browserPath } from "./render.mjs";
import { WHISPER_MODEL } from "./transcript.mjs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/** Minimum versions StreamHunter relies on, and why. */
export const REQUIREMENTS = {
  ffmpeg: { min: "6.0", why: "cutting, cropping, loudness normalization and H.264/AAC encoding" },
  ffprobe: { min: "6.0", why: "checking that inputs and outputs are valid video files" },
  whisper: { min: "20240930", why: "transcripts (large-v3-turbo needs 20240930 or later)" },
  "yt-dlp": { min: "2025.11.12", why: "YouTube needs yt-dlp 2025.11.12 or later with a JavaScript runtime" },
  deno: { min: "2.3", why: "the JavaScript runtime yt-dlp uses for YouTube" },
};

export function searchDirs(env = process.env) {
  return [...new Set([...(env.PATH ?? "").split(delimiter).filter(Boolean), ...EXTRA_DIRS])];
}

export function which(name, dirs) {
  for (const d of dirs) {
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONWARNINGS: "ignore" } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`, error: err ? err.message : null }),
    );
  });
}

/** Compares dotted versions ("9.0.2" vs "6.0", "2026.10.26" vs "2025.11.12"). */
export function atLeast(version, min) {
  if (!version) return false;
  const a = version.split(/[^0-9]+/).filter(Boolean).map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

async function probe(name, dirs) {
  const path = which(name, dirs);
  if (!path) return { name, found: false, path: null, version: null, ok: false, detail: "Not installed" };
  let version = null;
  const extra = {};
  if (name === "ffmpeg" || name === "ffprobe") {
    const r = await run(path, ["-hide_banner", "-version"]);
    version = /version (\S+)/.exec(r.out)?.[1] ?? null;
    if (name === "ffmpeg") {
      const enc = await run(path, ["-hide_banner", "-encoders"]);
      extra.videotoolbox = /h264_videotoolbox/.test(enc.out);
      extra.libx264 = /\blibx264\b/.test(enc.out);
      const f = await run(path, ["-hide_banner", "-filters"]);
      extra.loudnorm = /\bloudnorm\b/.test(f.out);
    }
  } else if (name === "whisper") {
    // The CLI has no --version; ask its own Python for the package version.
    const shebang = /^#!(\S+)/.exec(readFileSync(realpathSync(path), "utf8").slice(0, 300))?.[1];
    if (shebang) {
      const r = await run(shebang, ["-c", "import whisper,sys;print(whisper.__version__)"], 60000);
      version = r.ok ? r.out.trim().split(/\s+/).pop() : null;
    }
  } else {
    const r = await run(path, ["--version"]);
    version = name === "deno" ? (/deno (\S+)/.exec(r.out)?.[1] ?? null) : r.out.trim().split(/\s+/)[0] || null;
  }
  const req = REQUIREMENTS[name];
  const ok = atLeast(version, req.min);
  return { name, found: true, path, version, ok, detail: ok ? null : version ? `Version ${version} is older than ${req.min}` : "Version could not be read", ...extra };
}

export const REMOTION = { min: "4.0.545", why: "zooms, openings and captions in edited Shorts (Remotion templates)" };

/** Remotion lives in the companion's own node_modules (npm install), with its headless browser. */
export function detectRemotion(companionDir = fileURLToPath(new URL("..", import.meta.url))) {
  const pkg = join(companionDir, "node_modules", "@remotion", "renderer", "package.json");
  const base = { name: "remotion", min: REMOTION.min, why: REMOTION.why };
  if (!existsSync(pkg)) return { ...base, found: false, path: null, version: null, ok: false, detail: "Not installed: run npm install in the companion folder" };
  const version = JSON.parse(readFileSync(pkg, "utf8")).version;
  const browser = Boolean(browserPath(companionDir));
  const ok = atLeast(version, REMOTION.min) && browser;
  return { ...base, found: true, path: dirname(pkg), version, ok, detail: ok ? null : !browser ? "Its headless browser isn't downloaded yet: run the installer again" : `Version ${version} is older than ${REMOTION.min}` };
}

export async function detectTools(env = process.env) {
  const dirs = searchDirs(env);
  const list = await Promise.all(Object.keys(REQUIREMENTS).map((n) => probe(n, dirs)));
  const tools = Object.fromEntries(list.map((t) => [t.name, { ...t, min: REQUIREMENTS[t.name].min, why: REQUIREMENTS[t.name].why }]));
  tools.remotion = detectRemotion();
  if (tools.whisper.found) {
    // The model is downloaded once by the user (about 1.6 GB); the companion never downloads it.
    const modelDir = join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "whisper");
    tools.whisper.model = existsSync(join(modelDir, `${WHISPER_MODEL}.pt`)) ? WHISPER_MODEL : null;
    if (tools.whisper.ok && !tools.whisper.model) {
      tools.whisper.ok = false;
      tools.whisper.detail = `The ${WHISPER_MODEL} model isn't downloaded yet: run once in Terminal: whisper --model ${WHISPER_MODEL} <any audio file>`;
    }
  }
  return tools;
}
