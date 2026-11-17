import { ApiError } from "@/services/api-client";
import { createKickClient } from "@/platforms/kick";
import { createTwitchClient } from "@/platforms/twitch";
import { PlatformError } from "@/platforms/http";
import { getCredentials, setCredentials } from "@/platforms/credentials";
import type { Page, Streamer } from "@/types/api";
import { json } from "@/test/http";
import { configurePlatforms, fakePlatforms, type FakeChannel } from "@/test/platforms";
import { LocalApi } from "./local-api";
import { refreshStatuses } from "./streamers";

const TWITCH: FakeChannel[] = [
  { id: "1", login: "shroud", name: "shroud", live: true, viewers: 25_000, title: "ranked", game: "Valorant" },
  { id: "2", login: "shroudfan", name: "ShroudFan" },
];
const KICK: FakeChannel[] = [{ id: "77", login: "kickstar", live: true, viewers: 900, title: "IRL", game: "IRL" }];

const api = () => new LocalApi({ baseUrl: "http://localhost:8000" }, () => ({ twitch: createTwitchClient(), kick: createKickClient() }));

describe("platform clients (official APIs, editor's own app)", () => {
  it("explains what to set up when no credentials are saved", async () => {
    fakePlatforms({ twitch: TWITCH });
    await expect(createTwitchClient().search("shroud")).rejects.toMatchObject({ kind: "not_configured" });
    await expect(api().get("/api/v1/streamers/search?platform=kick&username=x")).rejects.toMatchObject({
      status: 503,
      code: "platform_not_configured",
    });
  });

  it("Twitch: app token, fuzzy search with the exact match first, viewer counts for live channels", async () => {
    await configurePlatforms();
    const { fetch, calls } = fakePlatforms({ twitch: TWITCH });
    const found = await createTwitchClient().search("shroud");
    expect(found.map((c) => [c.username, c.is_live, c.viewer_count])).toEqual([
      ["shroud", true, 25_000],
      ["shroudfan", false, null],
    ]);
    expect(found[0]).toMatchObject({ current_category: "Valorant", profile_image_url: "https://img/shroud.png", stream_started_at: "2026-11-17T10:00:00.000Z" });
    expect(calls).toEqual(["id.twitch.tv token", "twitch /helix/search/channels?query=shroud&first=20", "twitch /helix/streams?user_id=1&first=100"]);
    const helix = fetch.mock.calls.find(([u]) => String(u).includes("/helix/"))!;
    expect(helix[1]?.headers).toMatchObject({ Authorization: "Bearer id.twitch.tv-token", "Client-Id": "tw-client" });
    // The token is cached: a second search doesn't fetch another one.
    await createTwitchClient().search("shroud");
    expect(calls.filter((c) => c.endsWith("token"))).toHaveLength(1);
  });

  it("Twitch: live status in batches of 100, a fresh token once after 401", async () => {
    await configurePlatforms();
    const many = Array.from({ length: 150 }, (_, i) => ({ id: String(i + 10), login: `c${i}`, live: i % 50 === 0 }));
    const { calls } = fakePlatforms({ twitch: many });
    const live = await createTwitchClient().status(many.map((c) => ({ platform_user_id: c.id, username: c.login })));
    expect(live.map((c) => c.username)).toEqual(["c0", "c50", "c100"]);
    expect(calls.filter((c) => c.startsWith("twitch /helix/streams"))).toHaveLength(2);

    let first = true;
    fakePlatforms({ twitch: TWITCH }, () => null);
    const { fetch } = fakePlatforms({ twitch: TWITCH });
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (String(input).includes("/helix/") && first) {
        first = false;
        return json({ message: "invalid token" }, 401);
      }
      return original(input, init);
    });
    expect((await createTwitchClient().discoverLive(5)).map((c) => c.username)).toEqual(["shroud"]);
  });

  it("Kick: exact channel lookup with picture, live status, live discovery", async () => {
    await configurePlatforms();
    fakePlatforms({ kick: [...KICK, { id: "78", login: "sleepy" }] });
    const k = createKickClient();
    expect(await k.search("KickStar")).toEqual([
      { platform: "kick", platform_user_id: "77", username: "kickstar", display_name: "kickstar", profile_image_url: "https://kimg/kickstar.png",
        is_live: true, current_title: "IRL", current_category: "IRL", viewer_count: 900, stream_started_at: "2026-11-17T10:00:00.000Z" },
    ]);
    const status = await k.status([{ platform_user_id: "77", username: "kickstar" }, { platform_user_id: "78", username: "sleepy" }]);
    expect(status.map((c) => c.username)).toEqual(["kickstar"]); // offline channels are left out
    expect((await k.search("sleepy"))[0]).toMatchObject({ is_live: false, viewer_count: null, stream_started_at: null });
    expect((await k.discoverLive(10)).map((c) => [c.username, c.viewer_count])).toEqual([["kickstar", 900]]);
  });

  it("reports rate limits with the wait the platform asked for", async () => {
    await configurePlatforms();
    const { fetch } = fakePlatforms({});
    fetch.mockImplementation(async (input) =>
      String(input).includes("id.kick.com")
        ? json({ access_token: "t", expires_in: 3600 })
        : new Response("{}", { status: 429, headers: { "Retry-After": "42" } }),
    );
    const err = await createKickClient().discoverLive(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toMatchObject({ kind: "rate_limited", retryAfterSec: 42 });
  });

  it("stores credentials trimmed, and only complete ones", async () => {
    await setCredentials("twitch", { clientId: "  id ", clientSecret: " s " });
    await setCredentials("kick", { clientId: "id", clientSecret: "" });
    expect(await getCredentials()).toEqual({ twitch: { clientId: "id", clientSecret: "s" }, kick: null });
  });
});

describe("local API (no backend)", () => {
  it("adds, lists, updates and removes streamers on the monitoring list", async () => {
    await configurePlatforms();
    const { fetch } = fakePlatforms({ twitch: TWITCH, kick: KICK });
    const a = api();
    const s = await a.post<Streamer>("/api/v1/streamers", { platform: "twitch", username: "Shroud" });
    expect(s).toMatchObject({ id: 1, display_name: "shroud", is_live: true, viewer_count: 25_000, monitoring_enabled: true });
    await a.post("/api/v1/streamers", { platform: "kick", username: "kickstar" });
    const dup = await a.post("/api/v1/streamers", { platform: "twitch", username: "shroud" }).catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(ApiError);
    expect((dup as ApiError).code).toBe("already_in_watchlist");
    const missing = await a.post("/api/v1/streamers", { platform: "twitch", username: "nobody" }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404, code: "streamer_not_found" });

    const list = await a.get<Page<Streamer>>("/api/v1/streamers?limit=10");
    expect(list.total).toBe(2);
    await a.patch(`/api/v1/streamers/${s.id}`, { monitoring_enabled: false, is_favorite: true, display_name: "hacked" });
    expect(await a.get<Page<Streamer>>("/api/v1/streamers")).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 1, monitoring_enabled: false, is_favorite: true, display_name: "shroud" })]) });
    await a.delete(`/api/v1/streamers/${s.id}`);
    expect((await a.get<Page<Streamer>>("/api/v1/streamers")).total).toBe(1);
    expect(fetch.mock.calls.every(([u]) => !String(u).startsWith("http://localhost:8000"))).toBe(true); // never the old backend
  });

  it("refreshes live status and reports who went live or offline", async () => {
    await configurePlatforms();
    const channels: FakeChannel[] = [{ ...TWITCH[0]!, live: false }];
    fakePlatforms({ twitch: channels, kick: KICK });
    const a = api();
    await a.post("/api/v1/streamers", { platform: "twitch", username: "shroud" });
    await a.post("/api/v1/streamers", { platform: "kick", username: "kickstar" });
    channels[0]!.live = true;
    const clients = { twitch: createTwitchClient(), kick: createKickClient() };
    const r = await refreshStatuses(clients, new Date("2026-11-17T12:00:00Z"));
    expect(r).toMatchObject({ checked: 2, live: 2, unavailable: {} });
    expect(r.changes.map((c) => [c.streamer.username, c.change])).toEqual([["shroud", "went_live"]]);
    expect((await a.get<Page<Streamer>>("/api/v1/streams/live")).items.map((s) => s.username).sort()).toEqual(["kickstar", "shroud"]);

    channels[0]!.live = false;
    const r2 = await a.post<{ checked: number; live: number }>("/api/v1/streams/refresh");
    expect(r2).toMatchObject({ checked: 2, live: 1 });
  });

  it("keeps the last known state when a platform can't be checked", async () => {
    await configurePlatforms();
    const opts = { twitch: TWITCH, kick: KICK } as Parameters<typeof fakePlatforms>[0];
    fakePlatforms(opts);
    const a = api();
    await a.post("/api/v1/streamers", { platform: "twitch", username: "shroud" });
    fakePlatforms({ ...opts, failWith: { twitch: 429 } });
    const r = await refreshStatuses({ twitch: createTwitchClient(), kick: createKickClient() });
    expect(r.unavailable.twitch).toMatch(/slow down/);
    expect(r.retry_after.twitch).toBe(60);
    expect((await a.get<Page<Streamer>>("/api/v1/streamers")).items[0]).toMatchObject({ is_live: true });
  });

  it("discovers live channels and reports platform capabilities", async () => {
    fakePlatforms({ twitch: TWITCH, kick: KICK });
    const a = api();
    let caps = await a.get<{ platform: string; configured: boolean }[]>("/api/v1/platforms/capabilities");
    expect(caps.map((c) => c.configured)).toEqual([false, false]);
    await configurePlatforms();
    caps = await a.get("/api/v1/platforms/capabilities");
    expect(caps.map((c) => c.configured)).toEqual([true, true]);
    const live = await a.get<{ username: string; viewer_count: number; profile_image_url: string }[]>("/api/v1/discover/live?platform=twitch");
    expect(live).toEqual([expect.objectContaining({ username: "shroud", viewer_count: 25_000, profile_image_url: "https://img/shroud.png" })]);
  });

  it("still sends paths that aren't local yet to the old backend", async () => {
    const { fetch } = fakePlatforms({}, (url) => (url.startsWith("http://localhost:8000/api/v1/clips") ? json({ items: [], total: 0, limit: 1, offset: 0 }) : null));
    expect(await api().get("/api/v1/clips?limit=1")).toMatchObject({ total: 0 });
    expect(String(fetch.mock.calls[0]![0])).toBe("http://localhost:8000/api/v1/clips?limit=1");
  });
});
