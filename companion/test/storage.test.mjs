// 4.7: the work folder is cleaned at start, a damaged job record doesn't stay, no job starts on a full disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobQueue, RETENTION } from "../src/jobs.mjs";
import { usedBytes } from "../src/main.mjs";
import { ensureLayout } from "../src/paths.mjs";

const DAY = 24 * 3600 * 1000;
const T = Date.parse("2026-11-24T12:00:00Z");
const job = (id, over) => ({ id, kind: "edit", input: `${id}-in.mp4`, plan: null, template: "ffmpeg_clean_v1", state: "done", step: "Ready", progress: 1, attempts: 1, error: null, output: { video: `${id}-out.mp4`, thumbnail: null }, metrics: null, notes: [], created_at: new Date(T - DAY).toISOString(), updated_at: new Date(T - DAY).toISOString(), ...over });

test("start-up clean-up: tmp leftovers, week-old finished jobs with their files, day-old files no job refers to; damaged job records", () => {
  const dir = mkdtempSync(join(tmpdir(), "sh-store-"));
  ensureLayout(dir);
  const f = (n, bytes = 1000, ageMs = 0) => {
    const p = join(dir, "files", n);
    writeFileSync(p, Buffer.alloc(bytes));
    const t = (T - ageMs) / 1000;
    utimesSync(p, t, t);
  };
  mkdirSync(join(dir, "tmp", "x-whisper"));
  writeFileSync(join(dir, "tmp", "x-whisper", "a.json"), "{}");
  writeFileSync(join(dir, "tmp", "y.part"), Buffer.alloc(500));
  // A finished job from yesterday (kept, with its output), and one from 8 days ago (forgotten).
  writeFileSync(join(dir, "jobs", "recent.json"), JSON.stringify(job("recent")));
  f("recent-out.mp4", 1000, 2 * DAY);
  writeFileSync(join(dir, "jobs", "old.json"), JSON.stringify(job("old", { updated_at: new Date(T - RETENTION.finishedMs - DAY).toISOString() })));
  f("old-out.mp4", 3000, 8 * DAY);
  // A queued job from 3 days ago keeps its input.
  writeFileSync(join(dir, "jobs", "waiting.json"), JSON.stringify(job("waiting", { state: "queued", output: null })));
  f("waiting-in.mp4", 1000, 3 * DAY);
  // Files nobody refers to: an hour old (an upload about to be used: kept) and two days old (deleted).
  f("fresh-upload.mp4", 1000, 3600 * 1000);
  f("orphan.mp4", 7000, 2 * DAY);
  writeFileSync(join(dir, "jobs", "broken.json"), '{"id": "broken", "state": "enc');

  const logs = [];
  // A full disk, so the queued job doesn't start during this test.
  const q = createJobQueue({ dir, tools: {}, now: () => T, free: () => 0, log: (e, d) => logs.push([e, d]) });
  assert.deepEqual(q.cleaned, { tmp: 2, jobs: 1, files: 1, bytes: 2 + 500 + 3000 + 7000 });
  assert.deepEqual(readdirSync(join(dir, "tmp")), []);
  assert.deepEqual(readdirSync(join(dir, "files")).sort(), ["fresh-upload.mp4", "recent-out.mp4", "waiting-in.mp4"]);
  assert.deepEqual(readdirSync(join(dir, "jobs")).sort(), ["recent.json", "waiting.json"]);
  assert.equal(q.get("old"), null);
  assert.equal(q.get("recent").state, "done");
  assert.ok(logs.some(([e, d]) => e === "job_unreadable_removed" && d.file === "broken.json"));
  assert.equal(usedBytes(dir) > 3000, true);
  // On request (Settings → Companion → Clean up): the same rules, now.
  writeFileSync(join(dir, "tmp", "z.part"), Buffer.alloc(10));
  assert.deepEqual(q.housekeeping(), { tmp: 1, jobs: 0, files: 0, bytes: 10 });
});

test("no job starts when the disk is nearly full; the message says how much is free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sh-store-"));
  ensureLayout(dir);
  writeFileSync(join(dir, "files", "in.mp4"), Buffer.alloc(100));
  const q = createJobQueue({ dir, tools: { ffmpeg: "/usr/bin/false", ffprobe: "/usr/bin/false" }, free: () => 1.5 * 1024 ** 3 });
  q.add({ id: "d1", input: "in.mp4", kind: "transcribe" });
  const end = Date.now() + 5000;
  while (q.get("d1").state === "queued" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  const j = q.get("d1");
  assert.equal(j.state, "failed");
  assert.equal(j.error, "Not enough free disk space: 1.5 GB free, and StreamHunter keeps 2.0 GB free. Free some space, then try again.");
  assert.equal(j.attempts, 0, "nothing ran");
  assert.ok(existsSync(join(dir, "files", "in.mp4")), "the input stays until the job is removed");
});
