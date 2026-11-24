// 4.6: yt-dlp opt-in. A fake yt-dlp returns the documented JSON shapes (availability, live_status,
// age_limit, has_drm) so every refusal is tested without touching YouTube. This proves our checks
// and arguments, not YouTube's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafe, checkArgs, downloadArgs, FORBIDDEN, refusal, ytdlpError } from "../src/fetch.mjs";
import { createJobQueue } from "../src/jobs.mjs";
import { ensureLayout } from "../src/paths.mjs";
import { searchDirs, which } from "../src/tools.mjs";

const dirs = searchDirs(process.env);
const ffmpeg = which("ffmpeg", dirs);
const ffprobe = which("ffprobe", dirs);
const ID = "aaaaaaaaaa1";
const info = (over = {}) => ({ id: ID, title: "My run", channel: "Me", availability: "public", live_status: "not_live", age_limit: 0, duration: 4, formats: [{ format_id: "18", has_drm: false }], ...over });

test("arguments: URL built from the id, no cookies, no config, no login; forbidden options refused", () => {
  const c = checkArgs({ id: ID, deno: "/opt/homebrew/bin/deno" });
  assert.equal(c[0], `https://www.youtube.com/watch?v=${ID}`);
  for (const a of ["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--no-playlist", "--dump-single-json"]) assert.ok(c.includes(a), a);
  assert.deepEqual(c.slice(c.indexOf("--js-runtimes"), c.indexOf("--js-runtimes") + 2), ["--js-runtimes", "deno:/opt/homebrew/bin/deno"]);
  const d = downloadArgs({ id: ID, out: "/w/tmp/x/video.%(ext)s", ffmpeg: "/opt/homebrew/bin/ffmpeg", deno: null });
  for (const a of ["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--max-filesize", "--merge-output-format"]) assert.ok(d.includes(a), a);
  assert.ok(!d.includes("--js-runtimes"));
  for (const args of [c, d]) for (const a of args) assert.ok(!FORBIDDEN.some((r) => r.test(a)), a);
  for (const bad of ["--cookies", "--cookies-from-browser", "--username", "-u", "--password", "--netrc", "-n", "--netrc-cmd", "--video-password", "--client-certificate", "--ap-mso", "--add-headers", "--remote-components"])
    assert.throws(() => assertSafe([...c, bad, "x"]), /Refusing/, bad);
  for (const id of ["", "https://youtu.be/aaaaaaaaaa1", "aaaaaaaaaa1 --cookies x", "aaaa;rm -rf", "-aaaaaaaaaa"]) {
    if (/^[\w-]{11}$/.test(id)) continue;
    assert.throws(() => checkArgs({ id }), /Invalid video id/, id);
  }
});

test("availability: only public or unlisted, regular, not age-restricted, no DRM", () => {
  assert.equal(refusal(info(), ID), null);
  assert.equal(refusal(info({ availability: "unlisted" }), ID), null);
  const cases = [
    [{ availability: "private" }, /private/],
    [{ availability: "premium_only" }, /paid/],
    [{ availability: "subscriber_only" }, /members only/],
    [{ availability: "needs_auth" }, /sign-in/],
    [{ availability: null }, /didn't say/],
    [{ live_status: "is_live" }, /live stream/],
    [{ live_status: "is_upcoming" }, /live stream/],
    [{ live_status: "post_live" }, /live stream/],
    [{ live_status: undefined, is_live: true }, /live stream/],
    [{ age_limit: 18 }, /age-restricted/],
    [{ formats: [{ format_id: "1", has_drm: true }] }, /DRM/],
    [{ _has_drm: true }, /DRM/],
    [{ duration: 5 * 3600 }, /longer than 4 hours/],
    [{ duration: null }, /length is unknown/],
    [{ id: "bbbbbbbbbb1" }, /different video/],
  ];
  for (const [over, re] of cases) assert.match(refusal(info(over), ID) ?? "", re, JSON.stringify(over));
  assert.match(refusal(null, ID), /didn't return/);
  assert.equal(ytdlpError("WARNING: x\nERROR: [youtube] aaaaaaaaaa1: Sign in to confirm your age. This video may be inappropriate for some users."), "Sign in to confirm your age. This video may be inappropriate for some users.");
});

/** A fake yt-dlp: -J prints info.json; otherwise writes a short MP4 to --output with progress lines. */
function fakeYtdlp(dirFake, data, { failCheck = null, failDownload = null, slow = false, shortFile = false } = {}) {
  writeFileSync(join(dirFake, "info.json"), JSON.stringify(data));
  const p = join(dirFake, "yt-dlp");
  writeFileSync(
    p,
    `#!${process.execPath}
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const a = process.argv.slice(2);
fs.appendFileSync(path.join(${JSON.stringify(dirFake)}, "argv.log"), JSON.stringify(a) + "\\n");
if (a.includes("--dump-single-json")) {
  ${failCheck ? `process.stderr.write(${JSON.stringify(failCheck)}); process.exit(1);` : ""}
  process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(dirFake)}, "info.json"), "utf8"));
  process.exit(0);
}
${failDownload ? `process.stderr.write(${JSON.stringify(failDownload)}); process.exit(1);` : ""}
const out = a[a.indexOf("--output") + 1].replace("%(ext)s", "mp4");
for (const p of [10, 50, 100]) console.log("[download]  " + p + ".0% of 1.00MiB at 1.00MiB/s ETA 00:00");
${slow ? "setTimeout(() => {}, 60000); return;" : ""}
execFileSync(a[a.indexOf("--ffmpeg-location") + 1], ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=${shortFile ? 1 : 4}", "-f", "lavfi", "-i", "sine=duration=${shortFile ? 1 : 4}", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
`,
  );
  chmodSync(p, 0o755);
  return p;
}
function setup(data, opts) {
  const dir = mkdtempSync(join(tmpdir(), "sh-fetch-"));
  ensureLayout(dir);
  const fake = mkdtempSync(join(tmpdir(), "sh-fake-"));
  const q = createJobQueue({ dir, tools: { ffmpeg, ffprobe, ytdlp: fakeYtdlp(fake, data, opts) } });
  return { dir, fake, q, argv: () => readFileSync(join(fake, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}
async function waitFor(q, id, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = q.get(id);
    if (["done", "failed", "cancelled"].includes(j?.state)) return j;
    if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const skip = !ffmpeg || !ffprobe ? "ffmpeg not installed" : false;

test("a public video you confirmed: checked, downloaded to tmp, verified, moved; arguments have no cookies or login", { skip }, async () => {
  const s = setup(info());
  assert.throws(() => s.q.add({ id: "f0", kind: "fetch", options: { video_id: ID } }), /Confirm that you own/);
  assert.throws(() => s.q.add({ id: "f0", kind: "fetch", options: { video_id: "x --cookies y", confirmed: true } }), /Invalid video id/);
  s.q.add({ id: "f1", kind: "fetch", options: { video_id: ID, confirmed: true, basis: "own" } });
  const j = await waitFor(s.q, "f1");
  assert.equal(j.state, "done", j.error);
  assert.equal(j.kind, "fetch");
  assert.deepEqual({ ...j.output, size: j.output.size > 0 }, { video: "f1-fetched.mp4", video_id: ID, title: "My run", channel: "Me", availability: "public", duration: j.output.duration, width: 640, height: 360, size: true, has_audio: true });
  assert.ok(existsSync(join(s.dir, "files", "f1-fetched.mp4")));
  assert.deepEqual(readdirSync(join(s.dir, "tmp")), []);
  const runs = s.argv();
  assert.equal(runs.length, 2, "one check, one download");
  for (const a of runs) {
    assert.equal(a[0], `https://www.youtube.com/watch?v=${ID}`);
    assert.ok(a.includes("--no-cookies") && a.includes("--ignore-config"));
    assert.ok(!a.some((x) => FORBIDDEN.some((r) => r.test(x))));
  }
  // remove() deletes the file once the extension has it.
  assert.equal(s.q.remove("f1"), true);
  assert.equal(existsSync(join(s.dir, "files", "f1-fetched.mp4")), false);
});

test("refused videos are never downloaded, and nothing is retried another way", { skip }, async () => {
  for (const [over, re] of [
    [{ availability: "private" }, /private/],
    [{ availability: "subscriber_only" }, /members only/],
    [{ age_limit: 18 }, /age-restricted/],
    [{ live_status: "is_live" }, /live stream/],
    [{ formats: [{ has_drm: true }] }, /DRM/],
  ]) {
    const s = setup(info(over));
    s.q.add({ id: "r1", kind: "fetch", options: { video_id: ID, confirmed: true } });
    const j = await waitFor(s.q, "r1");
    assert.equal(j.state, "failed");
    assert.match(j.error, re);
    assert.equal(s.argv().length, 1, "only the check ran");
    assert.deepEqual(readdirSync(join(s.dir, "files")), []);
  }
  // yt-dlp itself says sign-in is needed: refused with its words, not retried.
  const s = setup(info(), { failCheck: "ERROR: [youtube] aaaaaaaaaa1: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.\n" });
  s.q.add({ id: "r2", kind: "fetch", options: { video_id: ID, confirmed: true } });
  const j = await waitFor(s.q, "r2");
  assert.equal(j.state, "failed");
  assert.match(j.error, /^Not fetched: Sign in to confirm/);
  assert.equal(s.argv().length, 1);
  assert.equal(j.attempts, 1);
  // A file that doesn't match the video's length is not kept.
  const t = setup(info({ duration: 30 }));
  t.q.add({ id: "r3", kind: "fetch", options: { video_id: ID, confirmed: true } });
  const k = await waitFor(t.q, "r3");
  assert.match(k.error, /4 s long but the video is 30 s/);
  assert.deepEqual(readdirSync(join(t.dir, "files")), []);
  assert.deepEqual(readdirSync(join(t.dir, "tmp")), []);
});

test("without yt-dlp: a clear message; cancel during the download leaves nothing", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sh-fetch-"));
  ensureLayout(dir);
  const q = createJobQueue({ dir, tools: { ffmpeg, ffprobe, ytdlp: null } });
  q.add({ id: "n1", kind: "fetch", options: { video_id: ID, confirmed: true } });
  assert.match((await waitFor(q, "n1")).error, /yt-dlp isn't installed/);

  const s = setup(info(), { slow: true });
  s.q.add({ id: "c1", kind: "fetch", options: { video_id: ID, confirmed: true } });
  const end = Date.now() + 20000;
  while (s.q.get("c1").state !== "downloading" && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 500));
  s.q.cancel("c1");
  assert.equal((await waitFor(s.q, "c1")).state, "cancelled");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(readdirSync(join(s.dir, "tmp")), []);
  assert.deepEqual(readdirSync(join(s.dir, "files")), []);
});
