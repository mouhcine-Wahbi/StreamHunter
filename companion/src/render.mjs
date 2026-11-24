/**
 * Remotion render worker, run as its own process by the job queue so its memory (Node, the
 * bundler, the headless browser) is measured and it can be stopped. Usage:
 *   node src/render.mjs <job.json>
 * job.json: { workDir, input (absolute path of the vertical base video), output, props }
 * Prints JSON lines: {progress}, {done}, {error}. Sends nothing over the network: no licence key is
 * passed, so Remotion registers no usage event (see the companion README).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = join(here, "..", "remotion");
const COMPANION_DIR = join(here, "..");

/**
 * The headless browser the installer set up in node_modules/.remotion. Remotion would otherwise look
 * for it relative to the current folder (Chrome starts the companion in its bin folder) and download
 * a second copy there, so the path is given explicitly and nothing is ever downloaded at render time.
 */
export function browserPath(dir = COMPANION_DIR) {
  const root = join(dir, "node_modules", ".remotion", "chrome-headless-shell");
  if (!existsSync(root)) return null;
  for (const platform of readdirSync(root, { withFileTypes: true })) {
    if (!platform.isDirectory()) continue;
    const base = join(root, platform.name);
    for (const sub of readdirSync(base)) {
      for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
        const p = join(base, sub, name);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");

/** A hash of the template sources: a new bundle only when a template changes. */
export function templateHash() {
  const h = createHash("sha256");
  for (const f of readdirSync(TEMPLATE_DIR).sort()) h.update(f).update(readFileSync(join(TEMPLATE_DIR, f)));
  return h.digest("hex").slice(0, 16);
}

export async function ensureBundle(workDir) {
  const dir = join(workDir, "cache", `remotion-${templateHash()}`);
  if (existsSync(join(dir, "index.html"))) return dir;
  const { bundle } = await import("@remotion/bundler");
  mkdirSync(join(workDir, "cache"), { recursive: true });
  for (const old of readdirSync(join(workDir, "cache")).filter((d) => d.startsWith("remotion-"))) rmSync(join(workDir, "cache", old), { recursive: true, force: true });
  await bundle({ entryPoint: join(TEMPLATE_DIR, "index.ts"), outDir: dir, enableCaching: false, publicDir: null });
  return dir;
}

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const LOG_LEVEL = process.env.SH_RENDER_LOG === "verbose" ? "verbose" : "error";
  // Remotion logs with console.log; keep stdout for the JSON lines the companion reads.
  console.log = console.info = console.warn = console.error;
  process.chdir(COMPANION_DIR);
  const browserExecutable = browserPath();
  if (!browserExecutable) throw new Error("Remotion's browser isn't set up. Run the installer again in the companion folder.");
  const { selectComposition, renderMedia } = await import("@remotion/renderer");
  out({ step: "bundling" });
  const serveUrl = await ensureBundle(job.workDir);
  // The base video is served from the bundle's public folder for this render only.
  const pub = join(serveUrl, "public");
  mkdirSync(pub, { recursive: true });
  const name = `in-${process.pid}.mp4`;
  copyFileSync(job.input, join(pub, name));
  try {
    const inputProps = { ...job.props, src: name };
    const composition = await selectComposition({ serveUrl, id: "CleanGaming", inputProps, browserExecutable, logLevel: LOG_LEVEL });
    out({ step: "rendering", frames: composition.durationInFrames });
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      browserExecutable,
      codec: "h264",
      crf: 18,
      audioCodec: "aac",
      audioBitrate: "160k",
      pixelFormat: "yuv420p",
      colorSpace: "bt709",
      concurrency: Math.max(1, Math.floor(availableParallelism() / 2)),
      outputLocation: job.output,
      overwrite: true,
      logLevel: LOG_LEVEL,
      onProgress: ({ progress }) => out({ progress }),
    });
    out({ done: true });
  } finally {
    rmSync(join(pub, name), { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    out({ error: e?.message ?? String(e) });
    process.exit(1);
  });
}
