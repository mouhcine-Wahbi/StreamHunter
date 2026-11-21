/**
 * 3.0 content discovery against fake YouTube / Twitch endpoints that follow the documented
 * response shapes. This proves the parsing and rules, not that the real services answer this way.
 */
import { db } from "@/local/db";
import { addSource, updateCandidate } from "@/local/sources";
import { check, NO_RIGHTS, RightsError, setCreatorRights, validateRights } from "@/local/rights";
import { setCredentials } from "@/platforms/credentials";
import { quotaUsed } from "@/platforms/youtube";
import { getSettings, updateSettings } from "@/store/storage";
import { json, mockFetch } from "@/test/http";
import type { Streamer } from "@/types/api";
import { isoDuration, listCandidates, passesFilters, popularityOf, twitchDuration, type Found } from "./discovery";
import { runDiscovery } from "./runner";

const NOW = new Date("2026-11-21T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function ytVideo(id: string, over: { title?: string; channel?: string; views?: number; likes?: number; comments?: number; published?: string; live?: string; duration?: string; lang?: string } = {}) {
  return {
    id,
    snippet: { title: over.title ?? `Video ${id}`, channelId: "UC" + "a".repeat(22), channelTitle: over.channel ?? "Creator", publishedAt: over.published ?? hoursAgo(10),
      liveBroadcastContent: over.live ?? "none", thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hq.jpg` } }, defaultAudioLanguage: over.lang ?? "en" },
    statistics: { viewCount: String(over.views ?? 50_000), likeCount: String(over.likes ?? 2000), commentCount: String(over.comments ?? 300) },
    contentDetails: { duration: over.duration ?? "PT12M30S" },
  };
}

function fakeServices() {
  const calls: string[] = [];
  const videos: Record<string, ReturnType<typeof ytVideo>> = {
    aaaaaaaaaa1: ytVideo("aaaaaaaaaa1", { title: "New upload", views: 120_000 }),
    aaaaaaaaaa2: ytVideo("aaaaaaaaaa2", { title: "Old upload", published: hoursAgo(24 * 30) }),
    aaaaaaaaaa3: ytVideo("aaaaaaaaaa3", { title: "Live now", live: "live" }),
    bbbbbbbbbb1: ytVideo("bbbbbbbbbb1", { title: "Trending gaming", views: 900_000 }),
    cccccccccc1: ytVideo("cccccccccc1", { title: "Keyword hit", views: 5000 }),
  };
  mockFetch((url) => {
    const u = new URL(url);
    calls.push(`${u.host}${u.pathname}${u.searchParams.get("chart") ? `?chart=${u.searchParams.get("chart")}` : ""}`);
    if (u.host === "www.youtube.com" && u.pathname === "/feeds/videos.xml")
      return new Response(`<feed><entry><yt:videoId>aaaaaaaaaa1</yt:videoId></entry><entry><yt:videoId>aaaaaaaaaa2</yt:videoId></entry><entry><yt:videoId>aaaaaaaaaa3</yt:videoId></entry></feed>`);
    if (u.host === "www.googleapis.com" && u.pathname === "/youtube/v3/videos") {
      if (u.searchParams.get("chart") === "mostPopular") return json({ items: [videos.bbbbbbbbbb1] });
      return json({ items: (u.searchParams.get("id") ?? "").split(",").map((id) => videos[id]).filter(Boolean) });
    }
    if (u.host === "www.googleapis.com" && u.pathname === "/youtube/v3/search") return json({ items: [{ id: { kind: "youtube#video", videoId: "cccccccccc1" } }] });
    if (u.host === "id.twitch.tv") return json({ access_token: "t", expires_in: 3600, token_type: "bearer" });
    if (u.host === "api.twitch.tv" && u.pathname === "/helix/games/top") return json({ data: [{ id: "509658", name: "Just Chatting" }] });
    if (u.host === "api.twitch.tv" && u.pathname === "/helix/search/categories") return json({ data: [{ id: "21779", name: "League of Legends" }] });
    if (u.host === "api.twitch.tv" && u.pathname === "/helix/clips")
      return json({ data: [{ id: `Clip${u.searchParams.get("game_id")}`, url: `https://clips.twitch.tv/Clip${u.searchParams.get("game_id")}`, broadcaster_id: "42", broadcaster_name: "Streamer42",
        title: "Huge play", view_count: 40_000, created_at: hoursAgo(5), thumbnail_url: "https://clips-media-assets2.twitch.tv/x.jpg", duration: 28.5, language: "en" }] });
    return null;
  });
  return calls;
}

describe("discovery rules (pure)", () => {
  it("parses durations and scores SOURCE popularity from measured numbers only", () => {
    expect(isoDuration("PT1H2M3S")).toBe(3723);
    expect(isoDuration("P1DT1S")).toBe(86401);
    expect(twitchDuration("3h2m1s")).toBe(10921);
    const p = popularityOf({ views: 100_000, likes: 4000, comments: 1000, published_at: hoursAgo(10) }, NOW);
    expect(p.score).toBeGreaterThan(60);
    expect(p.explain.at(-1)).toMatch(/ORIGINAL video, not the potential of a clip/);
    expect(popularityOf({ views: null, likes: null, comments: null, published_at: null }, NOW)).toMatchObject({ score: 0 });
    expect(popularityOf({ views: 1000, likes: null, comments: null, published_at: hoursAgo(1) }, NOW).explain[1]).toMatch(/views only/);
  });

  it("applies the date range, view, engagement and language filters", () => {
    const f = { views: 1000, likes: 10, comments: 0, published_at: hoursAgo(48), language: "en" } as Found;
    const base = { maxAgeDays: 7, minViews: 0, minEngagementPct: 0, language: "" };
    expect(passesFilters(f, base, NOW)).toBe(true);
    expect(passesFilters(f, { ...base, maxAgeDays: 1 }, NOW)).toBe(false);
    expect(passesFilters(f, { ...base, minViews: 5000 }, NOW)).toBe(false);
    expect(passesFilters(f, { ...base, minEngagementPct: 2 }, NOW)).toBe(false); // 1%
    expect(passesFilters(f, { ...base, language: "de" }, NOW)).toBe(false);
  });

  it("rights: nothing is allowed by default; each level needs confirmation and evidence", () => {
    expect(check(NO_RIGHTS, "analyze")).toMatchObject({ ok: false });
    expect(check(NO_RIGHTS, "publish", "youtube")).toEqual({ ok: false, reason: expect.stringMatching(/^Rights unclear/) });
    expect(() => validateRights({ status: "processing", evidence: "ok", confirmed: false }, NOW)).toThrow(/Confirm/);
    expect(() => validateRights({ status: "processing", evidence: "", confirmed: true }, NOW)).toThrow(/evidence/);
    expect(() => validateRights({ status: "publishing", evidence: "Creator's clipping programme", confirmed: true }, NOW)).toThrow(/destination/);
    const r = validateRights({ status: "publishing", evidence: "Creator's clipping programme", destinations: ["youtube"], confirmed: true }, NOW);
    expect(check(r, "process")).toEqual({ ok: true });
    expect(check(r, "publish", "youtube")).toEqual({ ok: true });
    expect(check(r, "publish", "tiktok")).toEqual({ ok: false, reason: "Your rights for this creator don't include TikTok." });
  });
});

describe("discovery runs (fake documented endpoints)", () => {
  beforeEach(async () => {
    await setCredentials("youtube", { apiKey: "AIzaFakeTestKey0123456789abcdef" });
    await setCredentials("twitch", { clientId: "tw", clientSecret: "sec" });
    await db.put("streamers", {
      id: undefined as unknown as number, platform: "youtube", platform_user_id: "UC" + "a".repeat(22), username: "creator", display_name: "Creator", profile_image_url: null, is_live: false,
      current_title: null, current_category: null, viewer_count: null, stream_started_at: null, status_checked_at: null, monitoring_enabled: true, is_favorite: false, discovery_enabled: true, updated_at: "",
    } as Streamer);
  });

  it("finds creator uploads (skipping live and out-of-range ones), YouTube and Twitch trending, and keywords; never duplicates", async () => {
    const calls = fakeServices();
    await updateSettings({ discovery: { keywords: ["league of legends"], keywordYouTube: true, maxAgeDays: 7 } });
    const run = await runDiscovery(await getSettings(), { now: () => NOW });
    expect(run.problems).toEqual({});
    const list = await listCandidates();
    expect(list.map((c) => c.title).sort()).toEqual(["Huge play", "Huge play", "Keyword hit", "New upload", "Trending gaming"]);
    const upload = list.find((c) => c.title === "New upload")!;
    expect(upload).toMatchObject({ platform: "youtube", via: ["creator_uploads"], reasons: ["New upload from Creator"], duration_seconds: 750, rights: { status: "unknown" }, processing: "not_started" });
    const clip = list.find((c) => c.source_id === "clip:Clip509658")!;
    expect(clip).toMatchObject({ platform: "twitch", kind: "clip", via: ["trending"], reasons: ["Most-viewed Twitch clips in Just Chatting"], likes: null });
    expect(list.find((c) => c.title === "Keyword hit")!.reasons).toEqual(['Keyword "league of legends" on YouTube']);
    // Quota: feed free; 1 (uploads details) + 1 (trending Gaming) + 100 (search) + 1 (details) = 103.
    expect(run.units).toBe(103);
    expect(await quotaUsed(NOW)).toBe(103);
    expect(calls.filter((c) => c.includes("feeds"))).toHaveLength(1);
    // A second run updates instead of duplicating; your rights and dismissals are kept.
    await updateCandidate(upload.id, { dismissed: true });
    const again = await runDiscovery(await getSettings(), { now: () => NOW });
    expect(again.added).toBe(0);
    expect((await listCandidates()).length).toBe(5);
    expect((await listCandidates()).find((c) => c.id === upload.id)!.dismissed).toBe(true);
  });

  it("each source fails on its own, in plain words; keyword search on YouTube stays off unless you enable it", async () => {
    fakeServices();
    await setCredentials("youtube", null);
    await updateSettings({ discovery: { keywords: ["league of legends"], keywordYouTube: true } });
    const run = await runDiscovery(await getSettings(), { now: () => NOW });
    expect(run.problems).toMatchObject({ "YouTube creator uploads": expect.stringMatching(/API key/), "YouTube trending": expect.stringMatching(/API key/) });
    expect((await listCandidates()).every((c) => c.platform === "twitch")).toBe(true);
    await setCredentials("youtube", { apiKey: "AIzaFakeTestKey0123456789abcdef" });
    await updateSettings({ discovery: { keywordYouTube: false } });
    const r2 = await runDiscovery(await getSettings(), { now: () => NOW, sources: ["keyword"] });
    expect(r2.units).toBe(0);
  });
});

describe("authorized sources", () => {
  const file = (type = "video/mp4") => Object.assign(new Blob([new Uint8Array(1000)], { type }), { name: "match.mp4" });

  it("refuses a file without rights; keeps provenance; marks the discovered video", async () => {
    fakeServices();
    await setCredentials("youtube", { apiKey: "AIzaFakeTestKey0123456789abcdef" });
    await runDiscovery(await getSettings(), { now: () => NOW, sources: ["trending"] });
    const cand = (await listCandidates()).find((c) => c.platform === "youtube")!;
    await expect(addSource(file(), { candidate_id: cand.id, creator_name: "" }, { status: "unknown" })).rejects.toThrow(RightsError);
    await expect(addSource(file("image/png"), { creator_name: "x" }, { status: "processing", evidence: "mine", confirmed: true })).rejects.toThrow(/MP4/);
    const src = await addSource(file(), { candidate_id: cand.id, creator_name: "" }, { status: "processing", evidence: "Licensed from the creator (email 2026-11-20)", confirmed: true }, NOW);
    expect(src).toMatchObject({ creator_name: "Creator", platform: "youtube", original_url: "https://www.youtube.com/watch?v=bbbbbbbbbb1", rights: { status: "processing", confirmed_at: NOW.toISOString() } });
    expect(await db.get<Blob>("sourceBlobs", src.id)).toBeDefined(); // (the fake IndexedDB keeps no Blob contents)
    expect((await listCandidates()).find((c) => c.id === cand.id)).toMatchObject({ processing: "source_added", rights: { status: "processing" } });
  });

  it("creator rights are stored with evidence and date", async () => {
    const r = await setCreatorRights("twitch:42", { platform: "twitch", creator_name: "Streamer42" }, { status: "publishing", evidence: "Partner clipping programme", destinations: ["youtube", "x"], confirmed: true }, NOW);
    expect(r).toMatchObject({ key: "twitch:42", status: "publishing", destinations: ["youtube", "x"], confirmed_at: NOW.toISOString() });
  });
});
