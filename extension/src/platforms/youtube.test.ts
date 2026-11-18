import { json, mockFetch } from "@/test/http";
import { setCredentials } from "./credentials";
import { createYouTubeAdapter, DAILY_BUDGET, feedVideoIds, parseYouTubeInput, quotaDay, quotaUsed } from "./youtube";
import { refreshStatuses } from "@/local/streamers";
import { createAdapters } from "./registry";
import { db } from "@/local/db";
import type { Streamer } from "@/types/api";

/**
 * A fake YouTube that answers with the response shapes documented for the Data API v3
 * (channels.list, videos.list, search.list, videoCategories.list, playlistItems.list) and the
 * public upload feed. This proves the adapter's logic, not that the real service behaves the same.
 */
const KEY = "AIzaSyA-abcdefghijklmnopqrstuvwxyz012";
const CH = "UC" + "a".repeat(22);
const CH2 = "UC" + "b".repeat(22);
const NOW = new Date("2026-11-18T20:00:00Z");

interface FakeYT {
  channels: Record<string, { title: string; handle: string; thumb: string }>;
  videos: Record<string, { channelId: string; title: string; live: "live" | "none" | "upcoming"; viewers?: string; start?: string; ended?: boolean; categoryId?: string }>;
  feeds: Record<string, string[] | "fail">;
  error?: { status: number; reason: string };
}

function fakeYouTube(y: FakeYT) {
  const calls: string[] = [];
  const fetch = mockFetch((url) => {
    const u = new URL(url);
    calls.push(`${u.hostname === "www.youtube.com" ? "feed" : u.pathname.replace("/youtube/v3", "")}`);
    if (u.hostname === "www.youtube.com") {
      const f = y.feeds[u.searchParams.get("channel_id") ?? ""];
      if (!f || f === "fail") return new Response("", { status: 500 });
      return new Response(`<?xml version="1.0"?><feed>${f.map((id) => `<entry><yt:videoId>${id}</yt:videoId></entry>`).join("")}</feed>`, { status: 200 });
    }
    expect(u.searchParams.get("key")).toBe(KEY);
    if (y.error) return json({ error: { code: y.error.status, message: "x", errors: [{ reason: y.error.reason }] } }, y.error.status);
    const channelItem = (id: string) => ({ id, snippet: { title: y.channels[id]!.title, customUrl: `@${y.channels[id]!.handle}`, thumbnails: { default: { url: y.channels[id]!.thumb } } } });
    switch (u.pathname) {
      case "/youtube/v3/channels": {
        const ids = u.searchParams.get("id")?.split(",") ?? [];
        const handle = u.searchParams.get("forHandle")?.replace(/^@/, "").toLowerCase();
        const found = handle ? Object.keys(y.channels).filter((id) => y.channels[id]!.handle.toLowerCase() === handle) : ids.filter((id) => y.channels[id]);
        return json({ kind: "youtube#channelListResponse", items: found.map(channelItem) });
      }
      case "/youtube/v3/videos": {
        const ids = u.searchParams.get("id")!.split(",");
        return json({
          items: ids.filter((id) => y.videos[id]).map((id) => {
            const v = y.videos[id]!;
            return {
              id,
              snippet: { channelId: v.channelId, channelTitle: y.channels[v.channelId]?.title ?? "?", title: v.title, categoryId: v.categoryId ?? "20", liveBroadcastContent: v.live },
              liveStreamingDetails: v.live === "none" && !v.ended ? undefined : { actualStartTime: v.start, ...(v.viewers ? { concurrentViewers: v.viewers } : {}), ...(v.ended ? { actualEndTime: "2026-11-18T19:00:00Z" } : {}) },
            };
          }),
        });
      }
      case "/youtube/v3/videoCategories":
        return json({ items: [{ id: "20", snippet: { title: "Gaming" } }] });
      case "/youtube/v3/playlistItems": {
        const ch = "UC" + u.searchParams.get("playlistId")!.slice(2);
        const ids = Object.keys(y.videos).filter((id) => y.videos[id]!.channelId === ch);
        return json({ items: ids.map((videoId) => ({ contentDetails: { videoId } })) });
      }
      case "/youtube/v3/search": {
        if (u.searchParams.get("type") === "channel")
          return json({ items: Object.keys(y.channels).map((id) => ({ id: { kind: "youtube#channel", channelId: id }, snippet: { channelId: id, title: y.channels[id]!.title, liveBroadcastContent: id === CH ? "live" : "none" } })) });
        const live = Object.keys(y.videos).filter((id) => y.videos[id]!.live === "live");
        return json({ items: live.map((videoId) => ({ id: { kind: "youtube#video", videoId }, snippet: { channelId: y.videos[videoId]!.channelId } })) });
      }
    }
    return null;
  });
  return { fetch, calls };
}

const WORLD: FakeYT = {
  channels: { [CH]: { title: "Alpha Live", handle: "AlphaLive", thumb: "https://yt3/a.jpg" }, [CH2]: { title: "Bravo", handle: "bravo", thumb: "https://yt3/b.jpg" } },
  videos: {
    liveVideo01: { channelId: CH, title: "Ranked grind", live: "live", viewers: "1234", start: "2026-11-18T18:00:00Z" },
    oldVideo001: { channelId: CH, title: "Yesterday", live: "none" },
    endedVid001: { channelId: CH2, title: "Ended stream", live: "none", ended: true },
  },
  feeds: { [CH]: ["liveVideo01", "oldVideo001"], [CH2]: ["endedVid001"] },
};

describe("YouTube adapter (documented Data API v3 shapes)", () => {
  it("reads channel links, @handles, IDs and video links", () => {
    expect(parseYouTubeInput(`https://www.youtube.com/channel/${CH}`)).toEqual({ kind: "id", value: CH });
    expect(parseYouTubeInput(CH)).toEqual({ kind: "id", value: CH });
    expect(parseYouTubeInput("youtube.com/@AlphaLive/streams")).toEqual({ kind: "handle", value: "AlphaLive" });
    expect(parseYouTubeInput("@AlphaLive")).toEqual({ kind: "handle", value: "AlphaLive" });
    expect(parseYouTubeInput("https://www.youtube.com/watch?v=liveVideo01&t=3")).toEqual({ kind: "video", value: "liveVideo01" });
    expect(parseYouTubeInput("https://youtu.be/liveVideo01")).toEqual({ kind: "video", value: "liveVideo01" });
    expect(parseYouTubeInput("https://www.youtube.com/live/liveVideo01")).toEqual({ kind: "video", value: "liveVideo01" });
    expect(parseYouTubeInput("https://www.youtube.com/c/OldCustomName")).toBeNull(); // would need a 100-unit search
    expect(feedVideoIds("<yt:videoId>abcdefghijk</yt:videoId><yt:videoId>bad</yt:videoId>")).toEqual(["abcdefghijk"]);
  });

  it("explains setup when there's no API key", async () => {
    fakeYouTube(WORLD);
    const yt = createYouTubeAdapter({}, () => NOW);
    await expect(yt.resolve("@AlphaLive")).rejects.toMatchObject({ kind: "not_configured" });
    expect(await yt.authStatus()).toMatchObject({ configured: false });
  });

  it("resolves channels for Add (1 unit each) and reports honest capabilities", async () => {
    await setCredentials("youtube", { apiKey: KEY });
    const { calls } = fakeYouTube(WORLD);
    const yt = createYouTubeAdapter({}, () => NOW);
    expect(await yt.resolve("https://www.youtube.com/@alphalive")).toMatchObject({ platform: "youtube", platform_user_id: CH, username: "alphalive", display_name: "Alpha Live", profile_image_url: "https://yt3/a.jpg" });
    expect(await yt.resolve("https://www.youtube.com/watch?v=liveVideo01")).toMatchObject({ platform_user_id: CH });
    await expect(yt.resolve("@nobody")).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual(["/channels", "/videos", "/channels", "/channels"]);
    expect(await quotaUsed(NOW)).toBe(4);
    expect(yt.capabilities().chat.support).toBe("unsupported");
    expect(yt.watchUrl({ platform_user_id: CH, username: "alphalive" })).toBe(`https://www.youtube.com/channel/${CH}/live`);
  });

  it("checks live status from the upload feed + one videos.list call, without search", async () => {
    await setCredentials("youtube", { apiKey: KEY });
    const { calls } = fakeYouTube(WORLD);
    const yt = createYouTubeAdapter({}, () => NOW);
    const live = await yt.status([{ platform_user_id: CH, username: "alphalive" }, { platform_user_id: CH2, username: "bravo" }]);
    expect(live).toEqual([
      expect.objectContaining({ platform_user_id: CH, is_live: true, current_title: "Ranked grind", current_category: "Gaming", viewer_count: 1234, stream_started_at: "2026-11-18T18:00:00.000Z" }),
    ]);
    expect(calls).toEqual(["feed", "feed", "/videos", "/videoCategories"]); // ended broadcast = not live
    expect(await quotaUsed(NOW)).toBe(2);
    expect(calls).not.toContain("/search");
  });

  it("falls back to the uploads playlist when the feed can't be read", async () => {
    await setCredentials("youtube", { apiKey: KEY });
    const { calls } = fakeYouTube({ ...WORLD, feeds: { [CH]: "fail" } });
    const live = await createYouTubeAdapter({}, () => NOW).status([{ platform_user_id: CH, username: "alphalive" }]);
    expect(live.map((c) => c.platform_user_id)).toEqual([CH]);
    expect(calls.slice(0, 2)).toEqual(["feed", "/playlistItems"]);
  });

  it("search and Live now cost 100 units and only run on request", async () => {
    await setCredentials("youtube", { apiKey: KEY });
    fakeYouTube(WORLD);
    const yt = createYouTubeAdapter({}, () => NOW);
    const found = await yt.search("alpha");
    expect(found.map((c) => [c.platform_user_id, c.is_live])).toEqual([[CH, true], [CH2, false]]);
    expect((await yt.discoverLive(10)).map((c) => c.platform_user_id)).toEqual([CH]);
    expect(await quotaUsed(NOW)).toBe(100 + 1 + 100 + 1 + 1);
  });

  it("stops before the daily budget, and explains YouTube's quota and key errors", async () => {
    await setCredentials("youtube", { apiKey: KEY });
    fakeYouTube(WORLD);
    await chrome.storage.local.set({ "sh.youtubeQuota": { day: quotaDay(NOW), used: DAILY_BUDGET } });
    const yt = createYouTubeAdapter({}, () => NOW);
    await expect(yt.resolve(CH)).rejects.toMatchObject({ kind: "rate_limited", message: expect.stringMatching(/daily YouTube budget/) });
    await chrome.storage.local.set({ "sh.youtubeQuota": { day: "2020-01-01", used: DAILY_BUDGET } }); // a new day
    fakeYouTube({ ...WORLD, error: { status: 403, reason: "quotaExceeded" } });
    await expect(yt.resolve(CH)).rejects.toMatchObject({ kind: "rate_limited" });
    fakeYouTube({ ...WORLD, error: { status: 400, reason: "keyInvalid" } });
    await expect(yt.resolve(CH)).rejects.toMatchObject({ kind: "unauthorized", message: "YouTube rejected the API key. Check it in Settings → Platforms." });
    fakeYouTube({ ...WORLD, error: { status: 403, reason: "accessNotConfigured" } });
    await expect(yt.resolve(CH)).rejects.toMatchObject({ message: expect.stringMatching(/Enable the YouTube Data API v3/) });
  });

  it("YouTube streamers go through the same monitoring refresh as Twitch and Kick", async () => {
    await setCredentials("youtube", { apiKey: KEY });
    fakeYouTube(WORLD);
    const adapters = createAdapters();
    const info = await adapters.youtube.resolve("@AlphaLive");
    await db.put("streamers", { ...info, id: undefined as unknown as number, status_checked_at: null, monitoring_enabled: true, is_favorite: false, updated_at: "" } as Streamer);
    const r = await refreshStatuses(adapters, NOW);
    expect(r).toMatchObject({ checked: 1, live: 1, unavailable: {} });
    expect((await db.all<Streamer>("streamers"))[0]).toMatchObject({ is_live: true, viewer_count: 1234, current_title: "Ranked grind" });
  });
});

describe("Twitch without a client secret", () => {
  it("uses the editor's Sign in with Twitch token for Helix, and says what's missing otherwise", async () => {
    await setCredentials("twitch", { clientId: "cid", clientSecret: "" });
    const seen: string[] = [];
    mockFetch((url, init) => {
      seen.push(`${new URL(url).pathname} ${(init?.headers as Record<string, string>)?.Authorization ?? ""}`);
      return url.includes("/helix/streams") ? json({ data: [] }) : null;
    });
    const twitch = createAdapters().twitch;
    await expect(twitch.status([{ platform_user_id: "1", username: "a" }])).rejects.toMatchObject({ kind: "not_configured", message: expect.stringMatching(/Sign in with Twitch/) });
    await chrome.storage.local.set({ "sh.twitchUser": { token: "user-token", userId: "9", login: "me", scopes: ["user:read:chat"], expiresAt: null } });
    expect(await twitch.status([{ platform_user_id: "1", username: "a" }])).toEqual([]);
    expect(seen).toEqual(["/helix/streams Bearer user-token"]); // no token endpoint, no secret anywhere
    expect(await twitch.authStatus()).toMatchObject({ configured: true, message: "Using your sign-in (me), no secret stored." });
  });
});
