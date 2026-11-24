import { db } from "@/local/db";
import { saveClip, deleteClip } from "@/local/clips";
import { listAssets, assetBlob, assetThumbnail, type Asset } from "@/local/assets";
import { listEditJobs } from "@/local/edits";
import { createEditingManager, EditError, type EditingDeps } from "@/background/editing-manager";
import type { CompanionEvent, CompanionJob } from "@/companion/client";
import { DEFAULT_SETTINGS, type Settings } from "@/types/settings";
import { sanitizeSettings } from "@/utils/settings";
import { buildEditPlan, decideEdit, dedupeKey, MAX_PATH_POINTS, TRIM } from "./rules";

const S = (p: Partial<Settings["editing"]> = {}): Settings => ({ ...DEFAULT_SETTINGS, editing: { ...DEFAULT_SETTINGS.editing, ...p } });
const facecam = { kind: "facecam_top" as const, facecam: { x: 0.75, y: 0, w: 0.25, h: 0.25 } };

describe("edit rules", () => {
  it("decides by score band: auto from 85, offer from 70, none below or when off", () => {
    const e = DEFAULT_SETTINGS.editing;
    expect(decideEdit(85, e)).toBe("auto");
    expect(decideEdit(100, e)).toBe("auto");
    expect(decideEdit(84, e)).toBe("offer");
    expect(decideEdit(70, e)).toBe("offer");
    expect(decideEdit(69, e)).toBe("none");
    expect(decideEdit(null, e)).toBe("none");
    expect(decideEdit(95, { ...e, enabled: false })).toBe("none");
    expect(decideEdit(75, { ...e, autoFrom: 75 })).toBe("auto");
  });

  it("builds a vertical plan from the layout and the measured action path", () => {
    const path = Array.from({ length: 200 }, (_, i) => [i * 0.25, i % 2 ? 0.2 : 0.8] as [number, number]);
    const plan = buildEditPlan({ width: 1920, height: 1080, duration: 50, peakSec: null, layout: facecam, actionPath: path }, DEFAULT_SETTINGS.editing);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.output).toEqual({ width: 1080, height: 1920, maxFps: 60 });
    expect(plan.panels).toHaveLength(2);
    expect(plan.panels[0]!.dy).toBe(0);
    expect(plan.panels[0]!.dh + plan.panels[1]!.dh).toBe(1920);
    expect(plan.panels[0]!.sxPath).toBeUndefined();
    const sx = plan.panels[1]!.sxPath!;
    expect(sx.length).toBeLessThanOrEqual(MAX_PATH_POINTS);
    for (const [, x] of sx) expect(x + plan.panels[1]!.sw).toBeLessThanOrEqual(1920);
    expect(plan.trim).toEqual({ start: 0, end: null });
    expect(plan.audio.loudnorm).toBe(true);
    expect(plan.encoder).toBe("videotoolbox");
  });

  it("starts a few seconds before a late strongest moment, never inventing anything", () => {
    const late = buildEditPlan({ width: 1920, height: 1080, duration: 60, peakSec: 40, layout: null, actionPath: null }, DEFAULT_SETTINGS.editing);
    if ("error" in late) throw new Error(late.error);
    expect(late.trim.start).toBe(40 - TRIM.leadIn);
    expect(late.thumbnailAt).toBe(TRIM.leadIn);
    expect(late.notes.join(" ")).toMatch(/before the strongest moment/);
    // Peak early, or too little left after the trim: keep the whole clip.
    for (const [peak, dur] of [[10, 60], [40, 43]]) {
      const p = buildEditPlan({ width: 1920, height: 1080, duration: dur!, peakSec: peak!, layout: null, actionPath: null }, DEFAULT_SETTINGS.editing);
      if ("error" in p) throw new Error(p.error);
      expect(p.trim.start).toBe(0);
    }
  });

  it("explains a missing action path and refuses non-landscape sources", () => {
    const p = buildEditPlan({ width: 1920, height: 1080, duration: 30, peakSec: null, layout: { kind: "action" }, actionPath: null }, DEFAULT_SETTINGS.editing);
    if ("error" in p) throw new Error(p.error);
    expect(p.notes.join(" ")).toMatch(/No action path/);
    // 4.3: the motion style zooms at the strongest moment (in seconds of the Short); the plain style has no motion.
    const m = buildEditPlan({ width: 1920, height: 1080, duration: 60, peakSec: 40, layout: null, actionPath: null }, DEFAULT_SETTINGS.editing);
    expect(m).toMatchObject({ template: "remotion_clean_gaming_v1", trim: { start: 32 }, motion: { zoomAt: 8, zoomScale: 1.12, fadeIn: 0.25 } });
    const early = buildEditPlan({ width: 1920, height: 1080, duration: 30, peakSec: null, layout: null, actionPath: null }, DEFAULT_SETTINGS.editing);
    expect(early).toMatchObject({ motion: { zoomAt: null } });
    const plain = buildEditPlan({ width: 1920, height: 1080, duration: 60, peakSec: 40, layout: null, actionPath: null }, S({ style: "clean_gaming" }).editing);
    expect(plain).toMatchObject({ template: "ffmpeg_clean_v1" });
    expect("motion" in plain).toBe(false);
    if ("error" in m || "error" in plain) throw new Error("no plan");
    expect(dedupeKey(1, m)).not.toBe(dedupeKey(1, plain));
    expect(buildEditPlan({ width: 1080, height: 1920, duration: 30, peakSec: null, layout: null, actionPath: null }, DEFAULT_SETTINGS.editing)).toEqual({ error: "Only landscape recordings are edited into Shorts." });
    expect(dedupeKey(1, p)).toBe(dedupeKey(1, { ...p }));
    expect(dedupeKey(1, p)).not.toBe(dedupeKey(1, { ...p, encoder: "x264" }));
  });

  it("settings: defaults, autoFrom never below offerFrom, unknown values rejected", () => {
    expect(sanitizeSettings({}).editing).toEqual(DEFAULT_SETTINGS.editing);
    expect(DEFAULT_SETTINGS.editing.captions).toBe(false);
    expect(sanitizeSettings({ editing: { autoFrom: 60, offerFrom: 80 } }).editing).toMatchObject({ autoFrom: 80, offerFrom: 80 });
    expect(sanitizeSettings({ editing: { encoder: "nvenc", style: "wild", offerFrom: 500 } }).editing).toMatchObject({ encoder: "videotoolbox", style: "clean_gaming_motion", offerFrom: 100 });
    expect(sanitizeSettings({ editing: { style: "clean_gaming" } }).editing.style).toBe("clean_gaming");
  });
});

/** A fake companion: stores uploads, accepts edit/start, lets the test send job events. */
function fakeCompanion({ available = true } = {}) {
  const files = new Map<string, Blob | Uint8Array>();
  const jobs = new Map<string, CompanionJob>();
  const listeners = new Set<(e: CompanionEvent) => void>();
  const calls: { type: string; payload: Record<string, unknown> }[] = [];
  let holds = 0;
  const companion = {
    endpoint: vi.fn(async () => {
      if (!available) throw new Error("not installed");
      return { base: "http://127.0.0.1:1", token: "t" };
    }),
    request: vi.fn(async <T,>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ type, payload });
      const id = payload.id_job as string;
      if (type === "edit/start") {
        const j: CompanionJob = { id, state: "queued", step: "Waiting", progress: 0, error: null, attempts: 0, output: null, metrics: null, notes: [], template: "ffmpeg_clean_v1" };
        jobs.set(id, j);
        return j as T;
      }
      if (type === "jobs/get") return (jobs.get(id) ?? null) as T;
      if (type === "jobs/cancel") {
        const j = jobs.get(id);
        if (j) j.state = "cancelled";
        return j as T;
      }
      if (type === "jobs/remove") return { removed: jobs.delete(id) } as T;
      throw new Error(`Unknown request: ${type}`);
    }),
    onEvent: (l: (e: CompanionEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    hold: (on: boolean) => void (holds += on ? 1 : -1),
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const name = decodeURIComponent(String(url).split("/").pop()!);
    if (init?.method === "PUT") {
      files.set(name, init.body as Blob);
      return new Response(JSON.stringify({ name, size: (init.body as Blob).size, sha256: "x" }), { status: 201 });
    }
    const f = files.get(name);
    return f ? new Response(f as BodyInit) : new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }) as unknown as typeof fetch;
  const emit = (job: CompanionJob) => listeners.forEach((l) => l({ event: "job", job }));
  /** Finish a job: the Short and its thumbnail appear in the companion's folder. */
  const finish = (id: string) => {
    files.set(`${id}-out.mp4`, new Uint8Array(4321));
    files.set(`${id}-thumb.jpg`, new Uint8Array(99));
    const j: CompanionJob = { ...jobs.get(id)!, state: "done", step: "Ready", progress: 1, output: { video: `${id}-out.mp4`, thumbnail: `${id}-thumb.jpg`, width: 1080, height: 1920, duration: 30, size: 4321, has_audio: true }, metrics: { wall_ms: 2500, cpu_ms: 3300, peak_rss_bytes: 230e6, encoder: "h264_videotoolbox" }, notes: ["Loudness normalized to about −14 LUFS."] };
    jobs.set(id, j);
    emit(j);
  };
  return { companion: companion as typeof companion & EditingDeps["companion"], fetchImpl, files, jobs, calls, emit, finish, holds: () => holds };
}

async function clipWith(score: number | null, { width = 1920, height = 1080 } = {}) {
  const started = Date.now();
  const c = await saveClip({ candidateId: 1, sessionId: null, streamerId: 1, streamerName: "Streamer", platform: "twitch", title: "Big play", startedAt: started, durationSec: 30, width, height, score: 80, blob: new Blob([new Uint8Array(1000)], { type: "video/mp4" }), peakAt: started + 20_000 });
  if (score !== null) await db.put("clips", { ...(await db.get<typeof c>("clips", c.id))!, viral: { total: score } });
  const now = new Date().toISOString();
  await db.put<Asset>("assets", { id: undefined as unknown as number, clip_id: c.id, kind: "vertical", layout: facecam, layout_source: "creator", used_layout: "facecam_top", status: "ready", error: null, attempts: 0, progress: 1, width: 1080, height: 1920, duration_seconds: 30, size_bytes: 1, reused_original: false, has_thumbnail: false, notes: [], action_path: [[0, 0.5], [10, 0.9], [20, 0.1]], created_at: now, updated_at: now });
  return c.id;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("editing manager", () => {
  it("edits a clip scoring 85+ automatically and saves the Short as a separate version", async () => {
    const f = fakeCompanion();
    const m = createEditingManager({ companion: f.companion, isRecording: async () => false, fetch: f.fetchImpl });
    const clip = await clipWith(91);
    const job = (await m.edit(clip, S(), "auto"))!;
    expect(job.state).toBe("queued");
    expect(job.trigger).toBe("auto");
    // (The test database doesn't keep Blobs as Blobs, so sizes are checked in real Chrome.)
    expect(f.files.has(`sh-edit-${job.id}-in.mp4`)).toBe(true);
    const start = f.calls.find((c) => c.type === "edit/start")!;
    expect(start.payload.plan).toMatchObject({ output: { width: 1080, height: 1920 }, template: "remotion_clean_gaming_v1", motion: { zoomScale: 1.12 } });
    expect(f.holds()).toBe(1);
    f.emit({ ...f.jobs.get(job.companion_id)!, state: "encoding", step: "Making the vertical Short (FFmpeg)", progress: 0.5 });
    await settle();
    expect((await listEditJobs(clip))[0]).toMatchObject({ state: "encoding", progress: 0.5 });
    f.finish(job.companion_id);
    await settle();
    const done = (await listEditJobs(clip))[0]!;
    expect(done.state).toBe("done");
    const assets = await listAssets(clip);
    const edited = assets.find((a) => a.kind === "edited_vertical")!;
    expect(edited).toMatchObject({ status: "ready", width: 1080, height: 1920, template: "remotion_clean_gaming_v1", edit_job_id: job.id, has_thumbnail: true });
    expect(edited.metrics?.encoder).toBe("h264_videotoolbox");
    expect(await assetBlob(edited)).toBeDefined();
    expect(await assetThumbnail(edited.id)).toBeDefined();
    expect(edited.size_bytes).toBe(4321);
    // The original and the plain vertical version are untouched.
    expect(assets.find((a) => a.kind === "vertical")).toBeTruthy();
    expect(await db.get<Blob>("clipBlobs", clip)).toBeDefined();
    expect(f.calls.some((c) => c.type === "jobs/remove")).toBe(true);
    expect(f.holds()).toBe(0);
    // Never twice: the same clip and options returns the existing edit.
    expect((await m.edit(clip, S(), "auto"))!.id).toBe(job.id);
    expect(f.calls.filter((c) => c.type === "edit/start")).toHaveLength(1);
  });

  it("70–84 is offered, not automatic; below 70 isn't edited; portrait and missing companion skip quietly", async () => {
    const f = fakeCompanion();
    const m = createEditingManager({ companion: f.companion, isRecording: async () => false, fetch: f.fetchImpl });
    const mid = await clipWith(75);
    expect(await m.edit(mid, S(), "auto")).toBeNull();
    expect((await m.edit(mid, S(), "manual"))?.trigger).toBe("manual");
    const low = await clipWith(60);
    expect(await m.edit(low, S(), "auto")).toBeNull();
    await expect(m.edit(low, S(), "manual")).rejects.toThrow(/from a score of 70/);
    await expect(m.edit(await clipWith(null), S(), "manual")).rejects.toBeInstanceOf(EditError);
    expect(await m.edit(await clipWith(95, { width: 1080, height: 1920 }), S(), "auto")).toBeNull();
    const off = fakeCompanion({ available: false });
    const m2 = createEditingManager({ companion: off.companion, isRecording: async () => false, fetch: off.fetchImpl });
    expect(await m2.edit(await clipWith(95), S(), "auto")).toBeNull();
    expect(await m.edit(await clipWith(95), S({ enabled: false }), "auto")).toBeNull();
  });

  it("cancel, failure with retry, and deleting the clip removes its edits", async () => {
    const f = fakeCompanion();
    const m = createEditingManager({ companion: f.companion, isRecording: async () => false, fetch: f.fetchImpl });
    const clip = await clipWith(90);
    const job = (await m.edit(clip, S(), "auto"))!;
    expect((await m.cancel(job.id))?.state).toBe("cancelled");
    expect(f.calls.some((c) => c.type === "jobs/cancel")).toBe(true);
    expect(f.holds()).toBe(0);
    // A cancelled automatic edit isn't restarted automatically…
    expect((await m.edit(clip, S(), "auto"))?.state).toBe("cancelled");
    // …but Retry sends it again.
    const again = await m.retry(job.id);
    expect(again.state).toBe("queued");
    f.emit({ ...f.jobs.get(job.companion_id)!, state: "failed", step: "Failed", error: "The clip file is damaged or isn't a video." });
    await settle();
    expect((await listEditJobs(clip))[0]).toMatchObject({ state: "failed", error: "The clip file is damaged or isn't a video." });
    await deleteClip(clip);
    expect(await listEditJobs(clip)).toEqual([]);
  });

  it("waits while recording when asked, then resumes; recovers a job the companion finished while the worker was away", async () => {
    const f = fakeCompanion();
    let recording = true;
    const m = createEditingManager({ companion: f.companion, isRecording: async () => recording, fetch: f.fetchImpl });
    const clip = await clipWith(88);
    const waiting = (await m.edit(clip, S({ pauseWhileRecording: true }), "auto"))!;
    expect(waiting).toMatchObject({ state: "uploading", step: "Waiting until recording stops" });
    expect(f.calls.some((c) => c.type === "edit/start")).toBe(false);
    await m.resume(S({ pauseWhileRecording: true }));
    expect(f.calls.some((c) => c.type === "edit/start")).toBe(false);
    recording = false;
    await m.resume(S({ pauseWhileRecording: true }));
    expect(f.calls.some((c) => c.type === "edit/start")).toBe(true);
    // The worker restarts; meanwhile the companion finished the job (no event was received).
    const j = f.jobs.get(waiting.companion_id)!;
    f.files.set(`${j.id}-out.mp4`, new Uint8Array(10));
    f.jobs.set(j.id, { ...j, state: "done", output: { video: `${j.id}-out.mp4`, thumbnail: null, width: 1080, height: 1920, duration: 30, size: 10, has_audio: true }, metrics: { wall_ms: 1, cpu_ms: 1, peak_rss_bytes: 1, encoder: "libx264" } });
    const m2 = createEditingManager({ companion: f.companion, isRecording: async () => false, fetch: f.fetchImpl });
    await m2.resume(S());
    expect((await listEditJobs(clip))[0]).toMatchObject({ state: "done", error: null });
    expect((await listAssets(clip)).filter((a) => a.kind === "edited_vertical")).toHaveLength(1);
  });

  it("an older companion without editing gets a clear message", async () => {
    const f = fakeCompanion();
    f.companion.request.mockImplementation((async (type: string) => {
      throw new Error(`Unknown request: ${type}`);
    }) as never);
    const m = createEditingManager({ companion: f.companion, isRecording: async () => false, fetch: f.fetchImpl });
    const job = await m.edit(await clipWith(90), S(), "manual");
    expect(job).toMatchObject({ state: "failed" });
    expect(job!.error).toMatch(/Update it/);
  });
});
