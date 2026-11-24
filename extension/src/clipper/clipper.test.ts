/**
 * 4.5 YouTube Video Clipper: URL parsing, the approval gate, import, segments and their decisions.
 * YouTube is a fake that follows the documented response shapes (proves parsing, not the service).
 */
import { db } from "@/local/db";
import { deleteSource, listSources } from "@/local/sources";
import { RightsError } from "@/local/rights";
import { setCredentials } from "@/platforms/credentials";
import { createAdapters } from "@/platforms/registry";
import { LocalApi } from "@/local/local-api";
import { json, mockFetch } from "@/test/http";
import type { Candidate } from "@/discovery/discovery";
import { applyFilters, clipType, NO_FILTERS, type LibraryClip } from "@/pages/clips/library";
import { createEditingManager } from "@/background/editing-manager";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { sanitizeSettings } from "@/utils/settings";
import { buildSegments, decideSegment, decideSource, durationMatch, importForVideo, listSegments, parseYouTubeUrl, recoverClipper, saveSegments, type SpeechSegment } from "./clipper";

const api = () => new LocalApi(() => createAdapters());
const ID = "dQw4w9WgXcQ";
const video = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  snippet: { title: `Video ${id}`, channelId: "UC" + "a".repeat(22), channelTitle: "My Channel", publishedAt: "2026-11-01T10:00:00Z", liveBroadcastContent: "none", thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hq.jpg` } }, ...over },
  statistics: { viewCount: "1000", likeCount: "10", commentCount: "2" },
  contentDetails: { duration: "PT2M5S" },
});
const file = (bytes = 2000) => new File([new Uint8Array(bytes)], "my-video.mp4", { type: "video/mp4" });
const approveInput = { basis: "own" as const, status: "processing" as const, evidence: "My own channel: https://youtube.com/@me", confirmed: true };

async function candidate(): Promise<Candidate> {
  await setCredentials("youtube", { apiKey: "AIzaFakeTestKey0123456789abcdef" });
  mockFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/youtube/v3/videos") return json({ items: (u.searchParams.get("id") ?? "").split(",").map((id) => video(id)) });
    return null;
  });
  const [c] = await api().post<Candidate[]>("/api/v1/clipper/lookup", { url: `https://youtu.be/${ID}?t=30` });
  return c!;
}

describe("Clipper: finding a video", () => {
  it("reads video ids from every YouTube link form, and nothing else", () => {
    for (const u of [ID, `https://www.youtube.com/watch?v=${ID}&t=10s`, `youtube.com/watch?v=${ID}`, `https://m.youtube.com/watch?v=${ID}`, `https://music.youtube.com/watch?v=${ID}`, `https://youtu.be/${ID}`, `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/embed/${ID}`, `https://www.youtube.com/live/${ID}?si=x`, `https://www.youtube-nocookie.com/embed/${ID}`])
      expect(parseYouTubeUrl(u), u).toBe(ID);
    for (const u of ["", "hello", "https://www.youtube.com/@channel", "https://www.youtube.com/playlist?list=PL123", `https://youtube.com.evil.example/watch?v=${ID}`, `https://evil.example/watch?v=${ID}`, "https://youtu.be/short", `javascript:alert(1)//${ID}`])
      expect(parseYouTubeUrl(u), u).toBeNull();
  });

  it("search (search.list 100 units + videos.list) and a pasted link (videos.list 1 unit) save the videos with their details", async () => {
    await setCredentials("youtube", { apiKey: "AIzaFakeTestKey0123456789abcdef" });
    const calls: string[] = [];
    mockFetch((url) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.pathname === "/youtube/v3/search") return json({ items: [{ id: { videoId: "bbbbbbbbbb2" } }, { id: { videoId: "bbbbbbbbbb1" } }] });
      if (u.pathname === "/youtube/v3/videos") return json({ items: (u.searchParams.get("id") ?? "").split(",").map((id) => video(id)) });
      return null;
    });
    const found = await api().post<Candidate[]>("/api/v1/clipper/search", { q: "my best plays" });
    expect(found.map((c) => c.source_id)).toEqual(["bbbbbbbbbb2", "bbbbbbbbbb1"]); // YouTube's order
    expect(found[0]).toMatchObject({ title: "Video bbbbbbbbbb2", creator_name: "My Channel", duration_seconds: 125, url: "https://www.youtube.com/watch?v=bbbbbbbbbb2", via: ["clipper"], rights: { status: "unknown" } });
    expect(calls).toEqual(["/youtube/v3/search", "/youtube/v3/videos"]);
    await expect(api().post("/api/v1/clipper/lookup", { url: "https://example.com" })).rejects.toMatchObject({ status: 422, message: "That isn't a YouTube video link." });
    // A live broadcast isn't a Clipper source (YouTube's live videos are for Live Monitoring).
    mockFetch((url) => (new URL(url).pathname === "/youtube/v3/videos" ? json({ items: [video("cccccccccc1", { liveBroadcastContent: "live" })] }) : null));
    await expect(api().post("/api/v1/clipper/lookup", { url: "https://youtu.be/cccccccccc1" })).rejects.toMatchObject({ message: expect.stringMatching(/live broadcast/) });
  });

  it("without an API key a pasted link still works, with only the id (details unknown)", async () => {
    const [c] = await api().post<Candidate[]>("/api/v1/clipper/lookup", { url: `https://www.youtube.com/watch?v=${ID}` });
    expect(c).toMatchObject({ source_id: ID, url: `https://www.youtube.com/watch?v=${ID}`, duration_seconds: null, reasons: [expect.stringMatching(/without a YouTube API key/)] });
  });
});

describe("Clipper: approval gate and import", () => {
  it("approving needs why, evidence, confirmation and at least processing; reject is recorded; nothing imports without approval", async () => {
    const c = await candidate();
    await expect(importForVideo(c.id, file())).rejects.toThrow(/Approve the video/);
    await expect(decideSource(c.id, { approve: true, input: { ...approveInput, confirmed: false } })).rejects.toThrow(/Confirm/);
    await expect(decideSource(c.id, { approve: true, input: { ...approveInput, evidence: "" } })).rejects.toThrow(/evidence/);
    await expect(decideSource(c.id, { approve: true, input: { ...approveInput, status: "analysis" } })).rejects.toThrow(/Authorized for processing/);
    await expect(decideSource(c.id, { approve: true, input: { ...approveInput, basis: "" as never } })).rejects.toThrow(/why you may use/);
    const rejected = await decideSource(c.id, { approve: false, note: "Not mine" });
    expect(rejected.clipper).toMatchObject({ approval: "rejected", note: "Not mine" });
    await expect(importForVideo(c.id, file())).rejects.toBeInstanceOf(RightsError);
    const ok = await api().post<Candidate>(`/api/v1/clipper/videos/${c.id}/decision`, { approve: true, ...approveInput });
    expect(ok).toMatchObject({ clipper: { approval: "approved", basis: "own" }, rights: { status: "processing", evidence: approveInput.evidence } });
    const s = await importForVideo(c.id, file());
    expect(s).toMatchObject({ candidate_id: c.id, platform: "youtube", original_url: `https://www.youtube.com/watch?v=${ID}`, rights: { status: "processing" } });
    expect(await db.get<Candidate>("candidates", c.id)).toMatchObject({ processing: "source_added" });
  });

  it("the imported file is compared with the video's length", () => {
    expect(durationMatch(125, 125.4)).toMatchObject({ ok: true });
    expect(durationMatch(3600, 3630)).toMatchObject({ ok: true }); // within 1 %
    expect(durationMatch(125, 60)).toEqual({ ok: false, message: "The file is 60 s long but the YouTube video is 125 s. Is it the right file?" });
    expect(durationMatch(null, 60)).toBeNull();
  });
});

const speech: SpeechSegment[] = [
  { start: 8, end: 12.5, text: "No way, did you see that?", words: [{ w: "No", s: 8, e: 8.3 }, { w: "way,", s: 8.3, e: 8.8 }, { w: "did", s: 9, e: 9.2 }, { w: "you", s: 9.2, e: 9.4 }, { w: "see", s: 9.4, e: 9.8 }, { w: "that?", s: 9.8, e: 12.5 }] },
  { start: 40, end: 41, text: "Hello.", words: [{ w: "Hello.", s: 40, e: 41 }] },
];
const moments = [
  { at: 11, start: 10, end: 25, score: 80, reasons: ["Loud reaction (+14 dB)"], kinds: ["audio"] },
  { at: 13, start: 11, end: 26, score: 60, reasons: ["Scene change"], kinds: ["visual"] },
  { at: 70, start: 65, end: 80, score: 55, reasons: ["Loud reaction (+9 dB)"], kinds: ["audio"] },
];

describe("Clipper: segments", () => {
  it("from measured moments; boundaries move to whole sentences; the words said become the excerpt; overlaps keep the stronger", () => {
    const segs = buildSegments(moments, speech, 100);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 7.7, end: 25, score: 80, excerpt: "No way, did you see that?", reasons: ["Loud reaction (+14 dB)", "Speech: “No way, did you see that?”", "Starts and ends with whole sentences"] });
    expect(segs[1]).toEqual({ start: 65, end: 80, score: 55, excerpt: "", reasons: ["Loud reaction (+9 dB)"] });
    // Without a transcript: the measured moments only.
    expect(buildSegments(moments, null, 100)[0]).toMatchObject({ start: 10, end: 25, excerpt: "" });
    // Never past the end of the file.
    expect(buildSegments([{ at: 98, start: 95, end: 110, score: 50, reasons: ["x"], kinds: [] }], null, 100)[0]).toMatchObject({ end: 100 });
  });

  it("each segment is approved (cut into a clip) or rejected; regenerating keeps your decisions", async () => {
    const c = await candidate();
    await decideSource(c.id, { approve: true, input: approveInput });
    const src = await importForVideo(c.id, file());
    await db.put("sources", { ...src, analysis: "analyzed", duration_seconds: 125, moments, transcript_status: "done", transcript: { model: "large-v3-turbo", language: "en", segments: speech, dropped: 0, created_at: "" } });
    let segs = await saveSegments((await listSources())[0]!);
    expect(segs.map((s) => [s.start, s.status])).toEqual([[7.7, "pending"], [65, "pending"]]);
    const a = await decideSegment(segs[0]!.id, true);
    expect(a.status).toBe("approved");
    expect((await listSources())[0]!.pending_clips).toEqual([{ start: 7.7, end: 25, title: "My Channel – 0:07", score: 80, reasons: ["Loud reaction (+14 dB)", "Speech: “No way, did you see that?”", "Starts and ends with whole sentences"], segment_id: a.id }]);
    await decideSegment(segs[1]!.id, false);
    segs = await saveSegments((await listSources())[0]!);
    expect(segs.map((s) => [s.start, s.status])).toEqual([[7.7, "approved"], [65, "rejected"]]);
    // The decision on the video still guards the segments.
    await decideSource(c.id, { approve: false });
    await db.put("segments", { ...segs[1]!, status: "pending" });
    await expect(decideSegment(segs[1]!.id, true)).rejects.toThrow(/isn't approved/);
    // Deleting the source deletes its segments.
    await deleteSource(src.id);
    expect(await listSegments(src.id)).toEqual([]);
  });
});

describe("Clip Library: type", () => {
  it("livestream, YouTube video (Clipper) or local file, and a filter for it", () => {
    const base = { id: 1, platform: "twitch", score: 50, streamer_display_name: "A", created_at: "2026-11-01T00:00:00Z", started_at: "2026-11-01T00:00:00Z" } as unknown as LibraryClip;
    const yt = { ...base, id: 2, platform: "youtube", source_id: 4 } as LibraryClip;
    const local = { ...base, id: 3, platform: "local", source_id: 5 } as unknown as LibraryClip;
    expect([clipType(base), clipType(yt), clipType(local)]).toEqual(["livestream", "youtube_video", "local_file"]);
    expect(applyFilters([base, yt, local], () => [], { ...NO_FILTERS, type: "youtube_video" }).map((c) => c.id)).toEqual([2]);
  });
});

describe("4.6 yt-dlp (opt-in)", () => {
  function companion(result: { error?: string } = {}) {
    const calls: { type: string; payload: Record<string, unknown> }[] = [];
    const jobs = new Map<string, Record<string, unknown>>();
    const bytes = new Uint8Array(4000);
    return {
      calls,
      deps: {
        endpoint: async () => ({ base: "http://127.0.0.1:1", token: "t" }),
        request: async <T,>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
          calls.push({ type, payload });
          const id = payload.id_job as string;
          if (type === "fetch/start") {
            jobs.set(id, { id, kind: "fetch", state: "checking", step: "Checking", progress: 0 });
            return jobs.get(id) as T;
          }
          if (type === "jobs/get") {
            const j = jobs.get(id);
            if (j && j.state === "checking") Object.assign(j, result.error ? { state: "failed", error: result.error } : { state: "done", output: { video: `${id}-fetched.mp4` }, metrics: { wall_ms: 1 } });
            return (j ?? null) as T;
          }
          if (type === "jobs/remove") return { removed: jobs.delete(id) } as T;
          throw new Error(`Unknown request: ${type}`);
        },
        onEvent: () => () => undefined,
        hold: () => undefined,
      },
      fetchImpl: (async () => new Response(bytes)) as unknown as typeof fetch,
    };
  }
  const settings = (on: boolean) => ({ ...DEFAULT_SETTINGS, clipper: { allowDownloadTool: on } });

  it("off by default; needs approval as your own video or written permission, and a confirmation per video", async () => {
    expect(DEFAULT_SETTINGS.clipper.allowDownloadTool).toBe(false);
    expect(sanitizeSettings({}).clipper.allowDownloadTool).toBe(false);
    const c = await candidate();
    const f = companion();
    const m = createEditingManager({ companion: f.deps, isRecording: async () => false, fetch: f.fetchImpl, pollMs: 5 });
    await expect(m.fetchVideo(c.id, true, settings(false))).rejects.toThrow(/download tool is off/);
    await expect(m.fetchVideo(c.id, true, settings(true))).rejects.toThrow(/Approve the video/);
    await decideSource(c.id, { approve: true, input: { ...approveInput, basis: "licensed", evidence: "CC BY: https://youtube.com/..." } });
    await expect(m.fetchVideo(c.id, true, settings(true))).rejects.toThrow(/only for your own videos or videos you have written permission/);
    await decideSource(c.id, { approve: true, input: approveInput });
    await expect(m.fetchVideo(c.id, false, settings(true))).rejects.toThrow(/Confirm that you own/);
    expect(f.calls).toEqual([]); // the companion was never asked
  });

  it("the companion gets only the id (no URL, no cookies); a refusal is shown as is; success imports the file", async () => {
    const c = await candidate();
    await decideSource(c.id, { approve: true, input: { ...approveInput, basis: "permission", evidence: "Email from the creator, 2026-11-20" } });
    const no = companion({ error: "Not fetched: The video is private." });
    const m1 = createEditingManager({ companion: no.deps, isRecording: async () => false, fetch: no.fetchImpl, pollMs: 5 });
    await expect(m1.fetchVideo(c.id, true, settings(true))).rejects.toThrow("Not fetched: The video is private.");
    expect(await listSources()).toEqual([]);
    expect(no.calls.filter((x) => x.type === "fetch/start")).toHaveLength(1);

    const ok = companion();
    const m = createEditingManager({ companion: ok.deps, isRecording: async () => false, fetch: ok.fetchImpl, pollMs: 5 });
    const s = await m.fetchVideo(c.id, true, settings(true));
    expect(ok.calls.find((x) => x.type === "fetch/start")!.payload).toEqual({ id_job: `sh-fetch-${c.id}`, video_id: ID, confirmed: true, basis: "permission" });
    expect(s).toMatchObject({ candidate_id: c.id, platform: "youtube", obtained_via: "yt-dlp", size_bytes: 4000, rights: { status: "processing", evidence: "Email from the creator, 2026-11-20" } });
    expect(ok.calls.at(-1)).toMatchObject({ type: "jobs/remove" });
  });
});

describe("4.7 storage and recovery", () => {
  it("an import that wouldn't leave 2 GB of browser storage free is refused, with the numbers", async () => {
    const c = await candidate();
    await decideSource(c.id, { approve: true, input: approveInput });
    const est = vi.fn(async () => ({ quota: 3 * 1024 ** 3, usage: 0.5 * 1024 ** 3 }));
    Object.defineProperty(navigator, "storage", { value: { estimate: est }, configurable: true });
    try {
      const sized = (n: number) => Object.defineProperty(file(), "size", { value: n }); // no need to allocate it
      await expect(importForVideo(c.id, sized(600 * 1024 ** 2))).rejects.toThrow("Not enough browser storage: the file needs 0.6 GB, 2.5 GB is free, and StreamHunter keeps 2.0 GB free.");
      expect(await listSources()).toEqual([]);
      expect(await importForVideo(c.id, sized(100 * 1024 ** 2))).toMatchObject({ size_bytes: 100 * 1024 ** 2 });
    } finally {
      Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
    }
  });

  it("after a restart: a running transcription is marked interrupted; a segment whose cut was lost can be approved again", async () => {
    const c = await candidate();
    await decideSource(c.id, { approve: true, input: approveInput });
    const src = await importForVideo(c.id, file());
    await db.put("sources", { ...src, analysis: "analyzed", duration_seconds: 125, moments, transcript_status: "done", transcript: { model: "m", language: "en", segments: speech, dropped: 0, created_at: "" } });
    const segs = await saveSegments((await listSources())[0]!);
    await decideSegment(segs[0]!.id, true); // queued for cutting: stays approved
    await decideSegment(segs[1]!.id, true);
    // The runner took the second request off the queue and the worker stopped mid-cut.
    const s = (await listSources())[0]!;
    await db.put("sources", { ...s, transcript_status: "running", pending_clips: s.pending_clips!.filter((r) => r.segment_id === segs[0]!.id) });
    expect(await recoverClipper()).toEqual({ transcripts: 1, segments: 1 });
    expect((await listSources())[0]).toMatchObject({ transcript_status: "failed", transcript_error: expect.stringMatching(/Interrupted/) });
    expect((await listSegments(src.id)).map((g) => [g.status, g.error])).toEqual([["approved", null], ["failed", "Interrupted while cutting (the extension restarted). Approve it again."]]);
    expect(await recoverClipper()).toEqual({ transcripts: 0, segments: 0 });
    expect(await decideSegment(segs[1]!.id, true)).toMatchObject({ status: "approved", error: null });
    expect((await listSources())[0]!.pending_clips!.map((r) => r.segment_id)).toEqual([segs[0]!.id, segs[1]!.id]);
  });
});
