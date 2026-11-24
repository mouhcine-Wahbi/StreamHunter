import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createDecoder, encode, MAX_TO_CHROME } from "../src/native.mjs";
import { inside, isSafeName } from "../src/paths.mjs";
import { atLeast, detectTools } from "../src/tools.mjs";
import { startFileServer } from "../src/server.mjs";
import { createCompanion } from "../src/main.mjs";
import { install, uninstall, HOST_NAME } from "../install.mjs";

const ID = "ldjgbenlpmpdfnmpcdhddildbhdagodi";
const ORIGIN = `chrome-extension://${ID}`;
const tmp = () => mkdtempSync(join(tmpdir(), "sh-comp-"));

test("framing: round trip, split chunks, several messages in one chunk", () => {
  const got = [];
  const feed = createDecoder((m) => got.push(m), (e) => assert.fail(e));
  const a = encode({ id: 1, type: "hello" });
  const b = encode({ id: 2, text: "héllo ✓" });
  const all = Buffer.concat([a, b]);
  for (let i = 0; i < all.length; i += 3) feed(all.subarray(i, i + 3)); // 3-byte chunks
  assert.deepEqual(got, [{ id: 1, type: "hello" }, { id: 2, text: "héllo ✓" }]);
  feed(Buffer.concat([a, b]));
  assert.equal(got.length, 4);
});

test("framing: refuses messages to Chrome over 1 MB and oversized or broken input", () => {
  assert.throws(() => encode({ x: "a".repeat(MAX_TO_CHROME) }), /too large for Chrome/);
  const errors = [];
  const feed = createDecoder(() => assert.fail("no message expected"), (e) => errors.push(e.message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(65 * 1024 * 1024, 0);
  feed(head);
  const bad = Buffer.from("{nope");
  const h2 = Buffer.alloc(4);
  h2.writeUInt32LE(bad.length, 0);
  feed(Buffer.concat([h2, bad]));
  assert.deepEqual(errors, ["Incoming message too large (68157440 bytes)", "Incoming message is not valid JSON"]);
});

test("names: only plain file names inside the work folder", () => {
  for (const ok of ["clip-12.mp4", "a.b_c", "X1"]) assert.ok(isSafeName(ok), ok);
  for (const bad of ["../x", "a/b", ".hidden", "", "a..b", "x".repeat(200), "a\\b", "c:d", "a b"]) assert.ok(!isSafeName(bad), bad);
  assert.throws(() => inside("/tmp/w", "../../etc/passwd"), /Invalid/);
});

test("versions compare numerically", () => {
  assert.ok(atLeast("9.0.2", "6.0"));
  assert.ok(atLeast("2026.10.26", "2025.11.12"));
  assert.ok(!atLeast("2025.10.22", "2025.11.12"));
  assert.ok(atLeast("2.9.8", "2.3"));
  assert.ok(!atLeast(null, "1"));
  assert.ok(atLeast("n7.1-tessus", "6.0"));
});

test("tools: found in the given PATH with their versions; missing ones reported, too old ones flagged", async () => {
  const bin = tmp();
  const script = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("yt-dlp", "echo 2025.01.01");
  script("deno", "echo 'deno 2.5.0 (stable)'");
  const t = await detectTools({ PATH: bin, HOME: bin });
  assert.equal(t["yt-dlp"].version, "2025.01.01");
  assert.equal(t["yt-dlp"].ok, false);
  assert.match(t["yt-dlp"].detail, /older than 2025\.11\.12/);
  assert.equal(t.deno.ok, true);
  // ffmpeg may exist in /opt/homebrew/bin on this machine; whichever, the shape is complete.
  for (const k of ["ffmpeg", "ffprobe", "whisper", "yt-dlp", "deno"]) assert.ok(k in t);
});

async function server(opts = {}) {
  const dir = tmp();
  mkdirSync(join(dir, "files"));
  const s = await startFileServer({ dir, origins: [ORIGIN], ...opts });
  const url = (p) => `http://127.0.0.1:${s.port}${p}`;
  const h = (extra = {}) => ({ origin: ORIGIN, "x-sh-token": s.token, ...extra });
  return { dir, s, url, h };
}

test("file channel: upload, list, download (same bytes and sha256), delete", async (t) => {
  const { dir, s, url, h } = await server();
  t.after(() => s.server.close());
  const data = randomBytes(3 * 1024 * 1024 + 7);
  const put = await fetch(url("/v1/files/clip-1.mp4"), { method: "PUT", headers: h(), body: data });
  assert.equal(put.status, 200);
  const r = await put.json();
  assert.equal(r.size, data.length);
  assert.equal(r.sha256, createHash("sha256").update(data).digest("hex"));
  assert.equal(put.headers.get("access-control-allow-origin"), ORIGIN);
  assert.deepEqual((await (await fetch(url("/v1/files"), { headers: h() })).json()).files, [{ name: "clip-1.mp4", size: data.length }]);
  const got = Buffer.from(await (await fetch(url("/v1/files/clip-1.mp4"), { headers: h() })).arrayBuffer());
  assert.ok(got.equals(data));
  assert.equal((await fetch(url("/v1/files/clip-1.mp4"), { method: "DELETE", headers: h() })).status, 200);
  assert.equal(existsSync(join(dir, "files", "clip-1.mp4")), false);
  assert.deepEqual(readdirSync(join(dir, "files")), []); // no leftover partial files
});

test("file channel: refuses wrong token, wrong origin, wrong host, bad names, too large and too little disk", async (t) => {
  const { s, url, h } = await server({ maxUpload: 1000 });
  t.after(() => s.server.close());
  assert.equal((await fetch(url("/v1/files"), { headers: { origin: ORIGIN } })).status, 401);
  assert.equal((await fetch(url("/v1/files"), { headers: h({ "x-sh-token": "0".repeat(64) }) })).status, 401);
  assert.equal((await fetch(url("/v1/files"), { headers: h({ origin: "https://evil.example" }) })).status, 403);
  assert.equal((await fetch(url("/v1/files"), { headers: { "x-sh-token": s.token } })).status, 403); // no Origin (e.g. curl)
  assert.equal((await fetch(`http://localhost:${s.port}/v1/files`, { headers: h() })).status, 421);
  assert.equal((await fetch(url("/v1/files/..%2F..%2Fetc%2Fpasswd"), { headers: h() })).status, 400);
  assert.equal((await fetch(url("/v1/files/.env"), { method: "PUT", headers: h(), body: "x" })).status, 400);
  assert.equal((await fetch(url("/v1/files/big.mp4"), { method: "PUT", headers: h(), body: Buffer.alloc(1001) })).status, 413);
  const pre = await fetch(url("/v1/files/a.mp4"), { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "PUT" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-headers"), "x-sh-token, content-type");
  const full = await server({ reserve: Number.MAX_SAFE_INTEGER });
  t.after(() => full.s.server.close());
  assert.equal((await fetch(full.url("/v1/files/a.mp4"), { method: "PUT", headers: full.h(), body: "abc" })).status, 507);
});

test("installer: writes the host manifest for one extension and a launcher; uninstall removes only the registration", () => {
  const chromeDir = tmp();
  const home = tmp();
  const r = install({ extensionId: ID, chromeDir, home, node: "/opt/node with space/node", main: "/x/it's/main.mjs" });
  const m = JSON.parse(readFileSync(r.manifest, "utf8"));
  assert.equal(r.manifest, join(chromeDir, "NativeMessagingHosts", `${HOST_NAME}.json`));
  assert.deepEqual(m, { name: HOST_NAME, description: "StreamHunter Companion (local video tools)", path: r.launcher, type: "stdio", allowed_origins: [`chrome-extension://${ID}/`] });
  const sh = readFileSync(r.launcher, "utf8");
  assert.match(sh, /exec '\/opt\/node with space\/node' '\/x\/it'\\''s\/main\.mjs' "\$@"/);
  assert.equal(statSync(r.launcher).mode & 0o111, 0o111);
  assert.throws(() => install({ extensionId: "not-an-id", chromeDir, home }), /extension ID/);
  assert.deepEqual(uninstall({ chromeDir }), { manifest: r.manifest, existed: true });
  assert.equal(existsSync(r.manifest), false);
  assert.ok(existsSync(join(home, "config.json")));
});

test("companion: answers only the registered extension", async () => {
  const dir = tmp();
  const out = [];
  const c = createCompanion({ dir, caller: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/", write: (m) => out.push(m), exit: () => undefined });
  c.feed(encode({ id: 1, type: "disk" }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /isn't allowed/);
  c.close();
});

test("end to end: Chrome-style launch, hello with tools and file channel, unknown request, exits when stdin closes", async (t) => {
  const home = tmp();
  const chromeDir = tmp();
  const { launcher } = install({ extensionId: ID, chromeDir, home });
  const p = spawn(launcher, [`chrome-extension://${ID}/`], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  t.after(() => p.exitCode === null && p.kill());
  const msgs = [];
  p.stdout.on("data", createDecoder((m) => msgs.push(m), (e) => assert.fail(e)));
  const next = async (n) => {
    for (let i = 0; i < 600 && msgs.length < n; i++) await new Promise((r) => setTimeout(r, 50));
    return msgs[n - 1];
  };
  p.stdin.write(encode({ id: 1, type: "hello" }));
  const hello = await next(1);
  assert.equal(hello.ok, true, hello.error);
  assert.equal(hello.data.protocol, 1);
  assert.equal(hello.data.work_dir, home);
  assert.match(hello.data.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(hello.data.tools).sort(), ["deno", "ffmpeg", "ffprobe", "remotion", "whisper", "yt-dlp"]);
  const put = await fetch(`http://127.0.0.1:${hello.data.port}/v1/files/t.bin`, { method: "PUT", headers: { origin: ORIGIN, "x-sh-token": hello.data.token }, body: "hello" });
  assert.equal(put.status, 200);
  assert.equal(readFileSync(join(home, "files", "t.bin"), "utf8"), "hello");
  p.stdin.write(encode({ id: 2, type: "rm -rf" }));
  assert.deepEqual(await next(2), { id: 2, ok: false, error: "Unknown request: rm -rf" });
  const exited = new Promise((r) => p.on("exit", r));
  p.stdin.end();
  assert.equal(await exited, 0);
  assert.match(readFileSync(join(home, "logs", "companion.log"), "utf8"), /"event":"start"/);
});
