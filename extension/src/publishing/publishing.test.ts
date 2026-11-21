/**
 * 3.0 phase 7: publishing jobs, every pre-publish check, the three platform flows against fake
 * servers shaped like the documented APIs, confirmation, retries, ambiguity, and account sign-in.
 * Nothing here talks to a real platform.
 */
import { db } from "@/local/db";
import { saveClip } from "@/local/clips";
import { patchAsset, queueAssets } from "@/local/assets";
import { approveJob, cancelJob, createJob, getJob, JobError, listJobs, patchJob, retryJob, safePostUrl, type PublishJob } from "@/local/jobs";
import { rightsKey, setCreatorRights, type Destination } from "@/local/rights";
import { fit, templateMetadata, factsOf } from "@/metadata/metadata";
import type { ClipScore } from "@/scoring/score";
import { DEFAULT_SETTINGS, type Settings } from "@/types/settings";
import type { Streamer } from "@/types/api";
import { accessToken, ACCOUNTS_KEY, connect, getAccount, listAccounts, pkce, setAppConfig, type AccountView } from "./accounts";
import { preflight, type PreflightInput } from "./checks";
import { fetchMetrics, tiktokChunks, TT, uploadHostOk, XAPI, YT } from "./platforms";
import { planAuto, planManual } from "./plan";
import { backoffMs, runPublishing, type RunnerDeps } from "./runner";

const MB = 1024 * 1024;
const settings = (patch: (s: Settings) => void = () => {}) => {
  const s = structuredClone(DEFAULT_SETTINGS);
  patch(s);
  return s;
};

// --- fake platform server ------------------------------------------------------------------------
type Req = { method: string; url: string; headers: Headers; body: BodyInit | null | undefined };
type Route = [method: string, match: string | RegExp, reply: (r: Req) => Response | Promise<Response>];
const ok = (j: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json", ...(init.headers as object) }, ...init });
function server(routes: Route[]) {
  const calls: Req[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const req = { method: init.method ?? "GET", url, headers: new Headers(init.headers), body: init.body };
    calls.push(req);
    const r = routes.find(([m, p]) => m === req.method && (typeof p === "string" ? url.startsWith(p) : p.test(url)));
    if (!r) return new Response(JSON.stringify({ error: { message: `no route ${req.method} ${url}` } }), { status: 404 });
    return r[2](req);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// --- fixtures ------------------------------------------------------------------------------------
const VIRAL = (tier: ClipScore["tier"], total = tier === "high" ? 90 : tier === "medium" ? 70 : 40): ClipScore => ({ total, confidence: 0.8, tier, factors: [], summary: `${total}: ${tier}`, fitBy: {} as ClipScore["fitBy"], computed_at: new Date().toISOString() });

async function makeClip(opts: { tier?: ClipScore["tier"]; rights?: Destination[] | null; size?: number; kinds?: ("vertical" | "landscape")[] } = {}) {
  const streamer = await db.put<Streamer>("streamers", { id: undefined as unknown as number, platform: "twitch", platform_user_id: `u${Math.random()}`, username: "streamerone", display_name: "StreamerOne" } as unknown as Streamer);
  if (opts.rights !== null) await setCreatorRights(rightsKey("twitch", streamer.platform_user_id), { platform: "twitch", creator_name: "StreamerOne" }, { status: "publishing", evidence: "Clipping programme terms", destinations: opts.rights ?? ["youtube", "tiktok", "x"], confirmed: true });
  const clip = await saveClip({ candidateId: 0, sessionId: null, streamerId: streamer.id, streamerName: "StreamerOne", platform: "twitch", title: "Big clutch", startedAt: Date.now(), durationSec: 30, width: 1920, height: 1080, score: 90, blob: new Blob([new Uint8Array(8)], { type: "video/mp4" }), category: "VALORANT", reasons: ["Loud reaction"] });
  const assets = await queueAssets(clip.id, opts.kinds ?? ["vertical", "landscape"], { layout: { kind: "center" }, source: "default" });
  for (const a of assets) {
    await patchAsset(a.id, { status: "ready", width: a.kind === "vertical" ? 1080 : 1920, height: a.kind === "vertical" ? 1920 : 1080, duration_seconds: 30, size_bytes: opts.size ?? 16 });
    files.set(a.id, new Blob([new Uint8Array(opts.size ?? 16)], { type: "video/mp4" }));
  }
  const f = factsOf(clip, streamer);
  const t = templateMetadata(f);
  const metadata = { byDestination: { youtube: fit("youtube", t.youtube, f, true), tiktok: fit("tiktok", t.tiktok, f, true), x: fit("x", t.x, f, true) }, generator: "template", fallbacks: [], generated_at: new Date().toISOString(), edited: [] };
  await db.put<{ id?: number }>("clips", { ...(await db.get<{ id: number }>("clips", clip.id))!, metadata, viral: VIRAL(opts.tier ?? "high") } as { id: number });
  return { clip, streamer, assets };
}

const connected = (d: Destination, over: Partial<AccountView> = {}): AccountView => ({ destination: d, configured: true, clientId: "client-1", tokenServer: null, connected: true, name: "Me", handle: "me", connected_at: "2026-11-21T00:00:00Z", problem: null, ...over });
const allConnected = async () => (["youtube", "tiktok", "x"] as const).map((d) => connected(d));
// fake-indexeddb doesn't keep Blob sizes, so made files are read from here in tests.
const files = new Map<number, Blob>();
const deps = (fetchImpl: typeof fetch, extra: Partial<RunnerDeps> = {}): RunnerDeps => ({
  fetchImpl,
  blob: async (a) => files.get(a.id),
  token: async () => ({ token: "user-token", profile: { id: "1", name: "Me", handle: "me" } }),
  accounts: allConnected,
  settings: async () => settings(),
  sleep: async () => undefined,
  inlineConfirmTries: 0,
  ...extra,
});

// --- platform fakes ------------------------------------------------------------------------------
function youtube(uploadStatus: () => string = () => "processed") {
  return server([
    ["POST", YT.upload, () => new Response("", { status: 200, headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc" } })],
    ["PUT", "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc", () => ok({ id: "vid123", status: { uploadStatus: "uploaded" } })],
    ["GET", `${YT.videos}?part=status`, () => ok({ items: [{ id: "vid123", status: { uploadStatus: uploadStatus() } }] })],
    ["GET", `${YT.videos}?part=statistics`, () => ok({ items: [{ statistics: { viewCount: "120", likeCount: "9", commentCount: "2" } }] })],
  ]);
}
function tiktok(opts: { options?: string[]; status?: () => string } = {}) {
  return server([
    ["POST", TT.creatorInfo, () => ok({ data: { creator_username: "me", privacy_level_options: opts.options ?? ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], max_video_post_duration_sec: 600 }, error: { code: "ok" } })],
    ["POST", TT.init, () => ok({ data: { publish_id: "v_pub_file~1", upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=t" }, error: { code: "ok" } })],
    ["PUT", "https://open-upload.tiktokapis.com/video/", () => new Response("", { status: 201 })],
    // Raw text: the post id is an int64 that a JavaScript number can't hold exactly.
    ["POST", TT.status, () => new Response(`{"data":{"status":"${opts.status?.() ?? "PUBLISH_COMPLETE"}","publicaly_available_post_id":[7300000000000000001],"fail_reason":"spam_risk"},"error":{"code":"ok"}}`, { status: 200 })],
  ]);
}
function x(opts: { processing?: () => string; postFails?: "network" | 503 } = {}) {
  return server([
    ["POST", XAPI.init, () => ok({ data: { id: "m1", media_key: "13_m1", expires_after_secs: 86400 } })],
    ["POST", XAPI.append("m1"), () => new Response(null, { status: 204 })],
    ["POST", XAPI.finalize("m1"), () => ok({ data: { id: "m1", processing_info: opts.processing ? { state: "pending", check_after_secs: 1 } : undefined } })],
    ["GET", XAPI.status("m1"), () => ok({ data: { id: "m1", processing_info: { state: opts.processing?.() ?? "succeeded" } } })],
    [
      "POST",
      XAPI.tweets,
      () => {
        if (opts.postFails === "network") throw new TypeError("Failed to fetch");
        if (opts.postFails === 503) return new Response("{}", { status: 503 });
        return ok({ data: { id: "1880000000000000001", text: "…" } });
      },
    ],
  ]);
}

// --- tests ---------------------------------------------------------------------------------------
describe("TikTok chunk rules (Media Transfer Guide)", () => {
  it("< 5 MB and ≤ 64 MB go whole; larger files use 10 MB chunks with the remainder in the last", () => {
    expect(tiktokChunks(3 * MB)).toMatchObject({ chunkSize: 3 * MB, count: 1, ranges: [[0, 3 * MB - 1]] });
    expect(tiktokChunks(40 * MB).count).toBe(1);
    const big = tiktokChunks(50_000_123 + 64 * MB);
    expect(big.chunkSize).toBe(10 * MB);
    expect(big.count).toBe(Math.floor((50_000_123 + 64 * MB) / (10 * MB)));
    const last = big.ranges.at(-1)!;
    expect(last[1]).toBe(50_000_123 + 64 * MB - 1);
    expect(last[1] - last[0] + 1).toBeGreaterThanOrEqual(10 * MB);
    expect(last[1] - last[0] + 1).toBeLessThan(128 * MB);
    for (let k = 1; k < big.ranges.length; k++) expect(big.ranges[k]![0]).toBe(big.ranges[k - 1]![1] + 1);
  });
});

describe("pre-publish checks, in order", () => {
  const base = async (): Promise<PreflightInput> => {
    const { clip } = await makeClip();
    const job = await createJob(clip.id, "youtube", { approved: false, auto: true });
    const row = (await db.get("clips", clip.id)) as PreflightInput["clip"];
    const { listAssets } = await import("@/local/assets");
    return { job, clip: row, assets: await listAssets(clip.id), rights: { status: "publishing", evidence: "x", destinations: ["youtube", "tiktok", "x"], confirmed_at: "" }, account: connected("youtube"), settings: settings(), siblings: [job], publishedToday: 0, now: new Date("2026-11-21T12:00:00") };
  };

  it("passes when everything is in place (high potential, auto-publishing on)", async () => {
    expect((await base()) && preflight(await base()).action).toBe("go");
  });

  it("each failing check blocks or waits with its reason", async () => {
    const b = await base();
    expect(preflight({ ...b, settings: settings((s) => (s.publishing.destinations.youtube.enabled = false)) })).toMatchObject({ action: "block", reason: expect.stringMatching(/turned off/) });
    expect(preflight({ ...b, rights: null })).toMatchObject({ action: "block", reason: expect.stringMatching(/Rights unclear/) });
    expect(preflight({ ...b, rights: { ...b.rights!, destinations: ["x"] } })).toMatchObject({ action: "block", reason: expect.stringMatching(/don't include YouTube Shorts/) });
    expect(preflight({ ...b, account: connected("youtube", { connected: false }) })).toMatchObject({ action: "block", reason: expect.stringMatching(/Connect your YouTube Shorts account/) });
    expect(preflight({ ...b, account: connected("youtube", { problem: "Renewal failed." }) })).toMatchObject({ action: "block", reason: "Renewal failed." });
    expect(preflight({ ...b, assets: [] })).toMatchObject({ action: "wait", reason: expect.stringMatching(/vertical version/) });
    expect(preflight({ ...b, assets: b.assets.map((a) => ({ ...a, status: "failed" as const, error: "decoder" })) })).toMatchObject({ action: "block", reason: expect.stringMatching(/failed: decoder/) });
    expect(preflight({ ...b, clip: { ...b.clip, metadata: null } })).toMatchObject({ action: "wait", reason: expect.stringMatching(/title and text/) });
    expect(preflight({ ...b, siblings: [b.job, { ...b.job, id: 999, state: "published", url: "https://www.youtube.com/shorts/v" }] })).toMatchObject({ action: "block", reason: expect.stringMatching(/Already published.*shorts\/v/) });
    expect(preflight({ ...b, publishedToday: 5 })).toMatchObject({ action: "wait", reason: expect.stringMatching(/Daily limit/), until: new Date("2026-11-22T00:00:00").toISOString() });
  });

  it("tiers: low never automatic, medium needs approval, high needs auto-publishing on; your approval overrides the tier", async () => {
    const b = await base();
    const tier = (t: ClipScore["tier"]) => ({ ...b.clip, viral: VIRAL(t) });
    expect(preflight({ ...b, clip: tier("low") })).toMatchObject({ action: "block", reason: expect.stringMatching(/Low potential/) });
    expect(preflight({ ...b, clip: tier("medium") }).action).toBe("approval");
    expect(preflight({ ...b, settings: settings((s) => (s.publishing.autoPublish = false)) })).toMatchObject({ action: "approval", reason: expect.stringMatching(/automatic publishing is off/) });
    expect(preflight({ ...b, clip: tier("low"), job: { ...b.job, approved: true } }).action).toBe("go");
    // Approval doesn't bypass rights.
    expect(preflight({ ...b, rights: null, job: { ...b.job, approved: true } }).action).toBe("block");
  });
});

describe("jobs", () => {
  it("one active job per clip and destination; approve / cancel / retry rules", async () => {
    const { clip } = await makeClip();
    const a = await createJob(clip.id, "x", { approved: false, auto: true });
    expect((await createJob(clip.id, "x", { approved: false, auto: true })).id).toBe(a.id);
    const approved = await createJob(clip.id, "x", { approved: true, auto: false });
    expect(approved).toMatchObject({ id: a.id, approved: true, state: "queued" });
    await patchJob(a.id, { state: "uploading" });
    await expect(cancelJob(a.id)).rejects.toBeInstanceOf(JobError);
    await expect(retryJob(a.id)).rejects.toThrow(/Only failed/);
    await patchJob(a.id, { state: "failed", attempts: 4 });
    expect(await retryJob(a.id)).toMatchObject({ state: "queued", attempts: 0, approved: true });
    expect(await cancelJob(a.id)).toMatchObject({ state: "cancelled" });
    // A cancelled job doesn't stop you from publishing again later.
    expect((await createJob(clip.id, "x", { approved: true, auto: false })).id).not.toBe(a.id);
    expect((await getJob(a.id)).history.map((h) => h.state)).toEqual(["queued", "queued", "uploading", "failed", "queued", "cancelled"]);
  });

  it("automatic jobs: only with auto-publishing on, rights for the destination, and high or medium potential", async () => {
    const high = await makeClip({ rights: ["youtube", "x"] });
    expect((await planAuto(high.clip.id, settings())).map((j) => j.destination)).toEqual(["youtube", "x"]);
    expect(await planAuto(high.clip.id, settings((s) => (s.publishing.autoPublish = false)))).toEqual([]);
    expect(await planAuto((await makeClip({ tier: "low" })).clip.id, settings())).toEqual([]);
    expect(await planAuto((await makeClip({ rights: null })).clip.id, settings())).toEqual([]);
    const off = await makeClip();
    expect((await planAuto(off.clip.id, settings((s) => (s.publishing.destinations.tiktok.enabled = false)))).map((j) => j.destination)).toEqual(["youtube", "x"]);
    await expect(planManual(off.clip.id, [])).rejects.toThrow(/at least one/);
  });
});

describe("YouTube: resumable upload, published only when YouTube says processed", () => {
  it("uploads with your metadata and privacy, then confirms", async () => {
    let status = "uploaded";
    const yt = youtube(() => status);
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["youtube"]);
    const published: PublishJob[] = [];
    await runPublishing(deps(yt.fetchImpl, { settings: async () => settings((s) => (s.publishing.youtubePrivacy = "unlisted")), onPublished: (j) => published.push(j) }));
    let j = await getJob(job!.id);
    expect(j).toMatchObject({ state: "confirming", ref: "vid123", published_at: null });
    const start = yt.calls.find((c) => c.method === "POST")!;
    expect(start.headers.get("authorization")).toBe("Bearer user-token");
    expect(start.headers.get("x-upload-content-length")).toBe("16");
    const meta = JSON.parse(String(start.body));
    expect(meta.status).toEqual({ privacyStatus: "unlisted", selfDeclaredMadeForKids: false });
    expect(meta.snippet.title).toBe("Big clutch");
    expect(meta.snippet.description).toContain("Credit: StreamerOne on Twitch https://www.twitch.tv/streamerone");
    expect(yt.calls.find((c) => c.method === "PUT")!.body).toBeInstanceOf(Blob);

    await runPublishing(deps(yt.fetchImpl)); // still "uploaded"
    j = await getJob(job!.id);
    expect(j.state).toBe("confirming");
    await patchJob(j.id, { next_at: null });
    status = "processed";
    await runPublishing(deps(yt.fetchImpl, { onPublished: (x) => published.push(x) }));
    j = await getJob(job!.id);
    expect(j).toMatchObject({ state: "published", platform_id: "vid123", url: "https://www.youtube.com/shorts/vid123" });
    expect(j.published_at).not.toBeNull();
    expect(published).toHaveLength(1);
    expect(j.metrics).toMatchObject({ views: 120, likes: 9, comments: 2, shares: null });
  });

  it("a rejected video fails with YouTube's reason", async () => {
    const yt = youtube(() => "rejected");
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["youtube"]);
    await runPublishing(deps(yt.fetchImpl, { inlineConfirmTries: 1 }));
    expect(await getJob(job!.id)).toMatchObject({ state: "failed", retryable: false, reason: expect.stringMatching(/YouTube rejected/) });
  });
});

describe("TikTok: Direct Post", () => {
  it("checks the account, sends the file in chunks and is published on PUBLISH_COMPLETE", async () => {
    const tt = tiktok();
    const { clip } = await makeClip({ size: 6 * MB });
    const [job] = await planManual(clip.id, ["tiktok"]);
    await runPublishing(deps(tt.fetchImpl, { inlineConfirmTries: 1, settings: async () => settings((s) => (s.publishing.tiktokPrivacy = "PUBLIC_TO_EVERYONE")) }));
    const init = JSON.parse(String(tt.calls.find((c) => c.url === TT.init)!.body));
    expect(init.post_info.privacy_level).toBe("PUBLIC_TO_EVERYONE");
    expect(init.post_info.title).toContain("Credit: StreamerOne");
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 6 * MB, chunk_size: 6 * MB, total_chunk_count: 1 });
    expect(tt.calls.find((c) => c.method === "PUT")!.headers.get("content-range")).toBe(`bytes 0-${6 * MB - 1}/${6 * MB}`);
    expect(await getJob(job!.id)).toMatchObject({ state: "published", platform_id: "7300000000000000001", url: "https://www.tiktok.com/@me/video/7300000000000000001" });
  });

  it("refuses a privacy level TikTok doesn't offer (unaudited apps: SELF_ONLY only)", async () => {
    const tt = tiktok({ options: ["SELF_ONLY"] });
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["tiktok"]);
    await runPublishing(deps(tt.fetchImpl, { settings: async () => settings((s) => (s.publishing.tiktokPrivacy = "PUBLIC_TO_EVERYONE")) }));
    expect(await getJob(job!.id)).toMatchObject({ state: "failed", retryable: false, reason: expect.stringMatching(/doesn't offer "PUBLIC_TO_EVERYONE".*SELF_ONLY/) });
    expect(tt.calls.some((c) => c.url === TT.init)).toBe(false);
  });

  it("FAILED from TikTok is a failure with its reason", async () => {
    const tt = tiktok({ status: () => "FAILED" });
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["tiktok"]);
    await runPublishing(deps(tt.fetchImpl, { inlineConfirmTries: 1 }));
    expect(await getJob(job!.id)).toMatchObject({ state: "failed", reason: "TikTok: spam_risk." });
  });
});

describe("X: chunked media upload and post", () => {
  it("initialize → append → finalize → post; published with the post link", async () => {
    const api = x();
    const { clip } = await makeClip({ size: 9 * MB });
    const [job] = await planManual(clip.id, ["x"]);
    await runPublishing(deps(api.fetchImpl));
    expect(JSON.parse(String(api.calls[0]!.body))).toEqual({ media_type: "video/mp4", total_bytes: 9 * MB, media_category: "tweet_video" });
    const appends = api.calls.filter((c) => c.url === XAPI.append("m1"));
    expect(appends).toHaveLength(3); // 4 MB segments
    expect((appends[2]!.body as FormData).get("segment_index")).toBe("2");
    const post = JSON.parse(String(api.calls.find((c) => c.url === XAPI.tweets)!.body));
    expect(post.media).toEqual({ media_ids: ["m1"] });
    expect(post.text).toContain("#StreamerOne");
    expect(await getJob(job!.id)).toMatchObject({ state: "published", platform_id: "1880000000000000001", url: "https://x.com/me/status/1880000000000000001" });
  });

  it("waits for X to process the video before posting", async () => {
    let state = "in_progress";
    const api = x({ processing: () => state });
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["x"]);
    await runPublishing(deps(api.fetchImpl, { inlineConfirmTries: 1 }));
    expect(await getJob(job!.id)).toMatchObject({ state: "confirming", ref: "media:m1" });
    expect(api.calls.some((c) => c.url === XAPI.tweets)).toBe(false);
    state = "succeeded";
    await patchJob(job!.id, { next_at: null });
    await runPublishing(deps(api.fetchImpl));
    expect((await getJob(job!.id)).state).toBe("published");
  });

  it("a lost connection while posting is never retried automatically (X may have posted)", async () => {
    const api = x({ postFails: "network" });
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["x"]);
    await runPublishing(deps(api.fetchImpl));
    const j = await getJob(job!.id);
    expect(j).toMatchObject({ state: "failed", retryable: false, posting: true, reason: expect.stringMatching(/check your X profile/) });
    await runPublishing(deps(api.fetchImpl));
    expect(api.calls.filter((c) => c.url === XAPI.tweets)).toHaveLength(1);
  });
});

describe("retries and errors", () => {
  it("server errors retry with backoff up to the limit, then fail for good", async () => {
    let now = new Date("2026-11-21T12:00:00Z");
    const down = server([["POST", YT.upload, () => new Response('{"error":{"message":"backend"}}', { status: 503 })]]);
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["youtube"]);
    const failed: PublishJob[] = [];
    const d = deps(down.fetchImpl, { now: () => now, settings: async () => settings((s) => (s.publishing.maxRetries = 2)), onFailed: (j) => failed.push(j) });
    await runPublishing(d);
    let j = await getJob(job!.id);
    expect(j).toMatchObject({ state: "failed", retryable: true, attempts: 1, reason: expect.stringMatching(/HTTP 503 \(backend\).*attempt 2 of 3/) });
    expect(Date.parse(j.next_at!) - now.getTime()).toBe(backoffMs(1));
    await runPublishing(d); // not due yet
    expect((await getJob(job!.id)).attempts).toBe(1);
    for (let k = 0; k < 2; k++) {
      now = new Date(Date.parse((await getJob(job!.id)).next_at!) + 1);
      await runPublishing(d);
    }
    j = await getJob(job!.id);
    expect(j).toMatchObject({ state: "failed", retryable: false, attempts: 3 });
    expect(failed).toHaveLength(1);
  });

  it("a rejected sign-in isn't retried", async () => {
    const denied = server([["POST", YT.upload, () => new Response("{}", { status: 401 })]]);
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["youtube"]);
    await runPublishing(deps(denied.fetchImpl));
    expect(await getJob(job!.id)).toMatchObject({ state: "failed", retryable: false, reason: expect.stringMatching(/sign-in was rejected/) });
  });

  it("jobs without rights or accounts are blocked, and nothing is sent", async () => {
    const yt = youtube();
    const { clip } = await makeClip({ rights: null });
    const [job] = await planManual(clip.id, ["youtube"]);
    await runPublishing(deps(yt.fetchImpl));
    expect(await getJob(job!.id)).toMatchObject({ state: "blocked", reason: expect.stringMatching(/Rights unclear/) });
    const other = await makeClip();
    const [job2] = await planManual(other.clip.id, ["youtube"]);
    await runPublishing(deps(yt.fetchImpl, { accounts: async () => [connected("youtube", { connected: false }), connected("tiktok"), connected("x")] }));
    expect(await getJob(job2!.id)).toMatchObject({ state: "blocked", reason: expect.stringMatching(/Connect your YouTube/) });
    expect(yt.calls).toHaveLength(0);
  });

  it("medium potential waits for approval, then publishes", async () => {
    const yt = youtube();
    const { clip } = await makeClip({ tier: "medium" });
    const [job] = await planAuto(clip.id, settings());
    await runPublishing(deps(yt.fetchImpl));
    expect(await getJob(job!.id)).toMatchObject({ state: "needs_approval" });
    expect(yt.calls).toHaveLength(0);
    await approveJob(job!.id);
    await runPublishing(deps(yt.fetchImpl, { inlineConfirmTries: 1 }));
    expect((await getJob(job!.id)).state).toBe("published");
  });

  it("a deleted clip cancels its jobs; an interrupted upload is retried", async () => {
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["youtube"]);
    await patchJob(job!.id, { state: "uploading", attempts: 1 }, undefined, new Date("2026-11-21T10:00:00Z"));
    await runPublishing(deps(youtube().fetchImpl, { now: () => new Date("2026-11-21T11:00:00Z") }));
    expect(await getJob(job!.id)).toMatchObject({ state: "failed", retryable: true, reason: expect.stringMatching(/interrupted/) });
    await db.delete("clips", clip.id);
    await patchJob(job!.id, { state: "queued", next_at: null });
    await runPublishing(deps(youtube().fetchImpl));
    expect((await getJob(job!.id)).state).toBe("cancelled");
  });

  it("each destination is independent", async () => {
    const yt = youtube();
    const failing = server([["POST", XAPI.init, () => new Response("{}", { status: 400 })]]);
    const both = ((u: string | URL | Request, i?: RequestInit) => (String(u).includes("api.x.com") ? failing.fetchImpl(u, i) : yt.fetchImpl(u, i))) as typeof fetch;
    const { clip } = await makeClip();
    await planManual(clip.id, ["youtube", "x"]);
    await runPublishing(deps(both, { inlineConfirmTries: 1 }));
    const jobs = await listJobs({ clipId: clip.id });
    expect(Object.fromEntries(jobs.map((j) => [j.destination, j.state]))).toEqual({ youtube: "published", x: "failed" });
  });
});

describe("metrics are real platform numbers", () => {
  it("X public metrics and TikTok video query (none for private posts)", async () => {
    const api = server([
      ["GET", XAPI.tweet("55"), () => ok({ data: { public_metrics: { impression_count: 1000, like_count: 50, reply_count: 4, retweet_count: 3, quote_count: 1 } } })],
      ["POST", TT.query, () => ok({ data: { videos: [{ id: "7", view_count: 300, like_count: 20, comment_count: 1, share_count: 2 }] }, error: { code: "ok" } })],
    ]);
    expect(await fetchMetrics("x", "55", "t", api.fetchImpl)).toMatchObject({ views: 1000, likes: 50, comments: 4, shares: 4 });
    expect(await fetchMetrics("tiktok", "7", "t", api.fetchImpl)).toMatchObject({ views: 300, shares: 2 });
    expect(await fetchMetrics("tiktok", "v_pub_file~1", "t", api.fetchImpl)).toBeNull();
  });
});

describe("accounts: your own apps, no secrets in the extension", () => {
  const redirect = "https://ldjgbenlpmpdfnmpcdhddildbhdagodi.chromiumapp.org/";
  beforeEach(() => {
    (chrome as unknown as { identity: object }).identity = { getRedirectURL: () => redirect };
  });

  it("X: PKCE S256, state checked, tokens stored but never shown, refreshed when expired", async () => {
    await setAppConfig("x", { clientId: "x-client-123" });
    let authorizeUrl = "";
    const api = server([
      ["POST", "https://api.x.com/2/oauth2/token", (r) => ok({ access_token: new URLSearchParams(String(r.body)).get("grant_type") === "refresh_token" ? "access-2" : "access-1", refresh_token: "refresh-2", expires_in: 7200, scope: "tweet.write" })],
      ["GET", "https://api.x.com/2/users/me", () => ok({ data: { id: "42", name: "Me", username: "me" } })],
    ]);
    const launch = async (url: string) => {
      authorizeUrl = url;
      const u = new URL(url);
      return `${redirect}?state=${u.searchParams.get("state")}&code=the-code`;
    };
    let t = Date.parse("2026-11-21T12:00:00Z");
    const view = await connect("x", { launch, fetchImpl: api.fetchImpl, now: () => t });
    expect(view).toMatchObject({ connected: true, name: "Me", handle: "me" });
    expect(JSON.stringify(await listAccounts())).not.toContain("access-1");
    const u = new URL(authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toContain("media.write");
    const tokenBody = new URLSearchParams(String(api.calls[0]!.body));
    expect(tokenBody.get("client_id")).toBe("x-client-123");
    expect(tokenBody.get("client_secret")).toBeNull();
    const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenBody.get("code_verifier")!)));
    expect(u.searchParams.get("code_challenge")).toBe(btoa(String.fromCharCode(...challenge)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));

    expect((await accessToken("x", { fetchImpl: api.fetchImpl, now: () => t })).token).toBe("access-1");
    t += 3 * 3600_000;
    expect((await accessToken("x", { fetchImpl: api.fetchImpl, now: () => t })).token).toBe("access-2");
    expect((await getAccount("x")).token!.refresh).toBe("refresh-2");
  });

  it("rejects a sign-in response with the wrong state", async () => {
    await setAppConfig("x", { clientId: "x-client-123" });
    await expect(connect("x", { launch: async () => `${redirect}?state=forged&code=c`, fetchImpl: server([]).fetchImpl })).rejects.toThrow(/didn't match/);
  });

  it("TikTok: the code goes to YOUR token server (hex challenge); the secret never touches the extension", async () => {
    await expect(setAppConfig("tiktok", { clientId: "tt-client-key", tokenServer: "http://tokens.example.com/tiktok" })).rejects.toThrow(/https/);
    await setAppConfig("tiktok", { clientId: "tt-client-key", tokenServer: "https://tokens.example.com/tiktok" });
    let authorizeUrl = "";
    const api = server([
      ["POST", "https://tokens.example.com/tiktok", () => ok({ access_token: "act.1", refresh_token: "rft.1", expires_in: 86400, refresh_expires_in: 31536000, open_id: "o", scope: "video.publish" })],
      ["POST", TT.creatorInfo, () => ok({ data: { creator_username: "me", creator_nickname: "Me", privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } })],
    ]);
    await connect("tiktok", { fetchImpl: api.fetchImpl, launch: async (url) => ((authorizeUrl = url), `${redirect}?state=${new URL(url).searchParams.get("state")}&code=tt-code&scopes=video.publish`) });
    const body = JSON.parse(String(api.calls[0]!.body));
    expect(body).toMatchObject({ grant_type: "authorization_code", client_key: "tt-client-key", code: "tt-code", redirect_uri: redirect });
    expect(JSON.stringify(body)).not.toMatch(/secret/);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier)));
    expect(new URL(authorizeUrl).searchParams.get("code_challenge")).toBe([...digest].map((b) => b.toString(16).padStart(2, "0")).join(""));
    expect((await listAccounts()).find((a) => a.destination === "tiktok")).toMatchObject({ connected: true, handle: "me" });
  });

  it("YouTube: implicit grant (no secret), channel read; a failed silent renewal asks you to connect again", async () => {
    await setAppConfig("youtube", { clientId: "123-abc.apps.googleusercontent.com" });
    const api = server([["GET", "https://www.googleapis.com/youtube/v3/channels", () => ok({ items: [{ id: "UC1", snippet: { title: "My Channel", customUrl: "@mine" } }] })]]);
    let t = Date.now();
    await connect("youtube", { fetchImpl: api.fetchImpl, now: () => t, launch: async (url) => `${redirect}#access_token=ya29.x&expires_in=3599&token_type=Bearer&state=${new URL(url).searchParams.get("state")}` });
    expect((await listAccounts())[0]).toMatchObject({ connected: true, name: "My Channel" });
    t += 2 * 3600_000;
    await expect(accessToken("youtube", { now: () => t, launch: async () => `${redirect}#error=interaction_required` })).rejects.toThrow(/Connect again/);
    expect((await listAccounts())[0]!.problem).toMatch(/Connect again/);
  });

  it("changing the app disconnects; PKCE verifiers are long and random", async () => {
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: { x: { config: { clientId: "old-client" }, token: { access: "a", refresh: null, expiresAt: 0, refreshExpiresAt: null, scope: "" }, profile: { id: "1", name: "n", handle: null }, connected_at: "t", problem: null } } });
    expect((await setAppConfig("x", { clientId: "new-client-1" })).connected).toBe(false);
    const a = await pkce(), b = await pkce();
    expect(a.verifier).toHaveLength(64);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("hardening (phase 9)", () => {
  it("the file and token are never sent to an upload address outside the platform", async () => {
    const evil = server([
      ["POST", YT.upload, () => new Response("", { status: 200, headers: { location: "https://uploads.attacker.example/put" } })],
      ["PUT", "https://uploads.attacker.example/", () => ok({ id: "x" })],
    ]);
    const { clip } = await makeClip();
    const [job] = await planManual(clip.id, ["youtube"]);
    await runPublishing(deps(evil.fetchImpl));
    expect(await getJob(job!.id)).toMatchObject({ state: "failed", retryable: false, reason: expect.stringMatching(/outside googleapis\.com/) });
    expect(evil.calls.some((c) => c.url.includes("attacker"))).toBe(false);

    const tt = server([
      ["POST", TT.creatorInfo, () => ok({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } })],
      ["POST", TT.init, () => ok({ data: { publish_id: "p", upload_url: "http://open-upload.tiktokapis.com/video/?x" }, error: { code: "ok" } })],
    ]);
    const other = await makeClip();
    const [tj] = await planManual(other.clip.id, ["tiktok"]);
    await runPublishing(deps(tt.fetchImpl));
    expect(await getJob(tj!.id)).toMatchObject({ state: "failed", reason: expect.stringMatching(/outside tiktokapis\.com/) });
    expect(tt.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(uploadHostOk("tiktok", "https://upload.us.tiktokapis.com/video/?a=1")).toBe(true);
    expect(uploadHostOk("tiktok", "https://tiktokapis.com.evil.example/")).toBe(false);
  });

  it("a slow progress write can't overwrite the final state", async () => {
    const api = x();
    const { clip } = await makeClip({ size: 9 * MB });
    const [job] = await planManual(clip.id, ["x"]);
    // Progress writes (read "uploading", then write) are slow, so without ordering they'd land after "published".
    const real = db.put.bind(db);
    const spy = vi.spyOn(db, "put").mockImplementation(async (store, value) => {
      const v = value as Partial<PublishJob>;
      if (store === "jobs" && v.state === "uploading" && (v.progress ?? 0) > 0) await new Promise((r) => setTimeout(r, 20));
      return real(store, value);
    });
    try {
      await runPublishing(deps(api.fetchImpl));
    } finally {
      spy.mockRestore();
    }
    await new Promise((r) => setTimeout(r, 60));
    expect(await getJob(job!.id)).toMatchObject({ state: "published", progress: 1 });
  });

  it("post links in the UI are https platform links only", () => {
    expect(safePostUrl("https://x.com/me/status/1")).toBe("https://x.com/me/status/1");
    expect(safePostUrl("javascript:alert(1)")).toBeNull();
    expect(safePostUrl("https://x.com.evil.example/a")).toBeNull();
    expect(safePostUrl("http://www.youtube.com/shorts/a")).toBeNull();
  });
});
