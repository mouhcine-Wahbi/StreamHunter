import { ApiClient } from "@/services/api-client";
import { getTabAudioState, setAuthToken } from "@/store/storage";
import { json, mockFetch } from "@/test/http";
import { channelFromUrl } from "@/types/tab-audio";
import { handleMessage } from "./message-handler";
import { createMonitoringManager } from "./monitoring-manager";
import { createTabAudioManager, type TabAudioDeps } from "./tab-audio";

const NOW = new Date("2026-11-16T12:00:00Z");

function deps(overrides: Partial<TabAudioDeps> = {}) {
  const offscreen: unknown[] = [];
  const d: TabAudioDeps = {
    now: () => NOW,
    createClient: (baseUrl) => new ApiClient({ baseUrl, getToken: async () => "tok" }),
    streamIdFor: vi.fn(async () => "stream-123"),
    ensureOffscreen: vi.fn(async () => undefined),
    closeOffscreen: vi.fn(async () => undefined),
    toOffscreen: vi.fn(async (m) => {
      offscreen.push(m);
      return { ok: true };
    }),
    ...overrides,
  };
  return { d, offscreen };
}

const samples = [
  { t: "2026-11-16T11:59:58.000Z", db: -31.2 },
  { t: "2026-11-16T11:59:59.000Z", db: -24.5 },
];

describe("channel detection from the tab URL", () => {
  it.each([
    ["https://www.twitch.tv/StreamerOne", { platform: "twitch", channel: "streamerone" }],
    ["https://m.twitch.tv/streamer_one/videos", { platform: "twitch", channel: "streamer_one" }],
    ["https://kick.com/kick-star?ref=x", { platform: "kick", channel: "kick-star" }],
    ["https://www.twitch.tv/directory/gaming", null],
    ["https://kick.com/categories", null],
    ["http://twitch.tv/streamerone", null],
    ["https://twitch.tv.evil.example/streamerone", null],
    ["https://www.youtube.com/@x", null],
    ["chrome://extensions", null],
    [undefined, null],
  ])("%s", (url, expected) => {
    expect(channelFromUrl(url)).toEqual(expected);
  });
});

describe("tab audio manager", () => {
  it("starts the offscreen meter for a channel tab", async () => {
    const { d, offscreen } = deps();
    const s = await createTabAudioManager(d).start(7, "https://www.twitch.tv/StreamerOne");
    expect(d.streamIdFor).toHaveBeenCalledWith(7);
    expect(offscreen).toEqual([{ target: "offscreen", type: "meter/start", streamId: "stream-123", sounds: false }]);
    expect(s).toMatchObject({ status: "measuring", tabId: 7, platform: "twitch", channel: "streamerone", startedAt: NOW.toISOString() });
    expect(await getTabAudioState()).toEqual(s);
  });

  it("refuses non-channel tabs and reports capture failures", async () => {
    const { d } = deps({ streamIdFor: vi.fn(async () => Promise.reject(new Error("Extension has not been invoked for the current page"))) });
    const m = createTabAudioManager(d);
    await expect(m.start(1, "https://example.com")).rejects.toThrow("Open a Twitch or Kick channel");
    await expect(m.start(1, "https://kick.com/kickstar")).rejects.toThrow(/didn't allow capturing.*not been invoked/);
    expect((await getTabAudioState()).status).toBe("off");

    const failing = deps({ toOffscreen: vi.fn(async () => ({ ok: false, error: "Permission dismissed" })) });
    await expect(createTabAudioManager(failing.d).start(1, "https://kick.com/kickstar")).rejects.toThrow("Permission dismissed");
    expect(failing.d.closeOffscreen).toHaveBeenCalled();
  });

  it("sends batches to the backend and reflects its answer", async () => {
    await setAuthToken("tok");
    let answer: Response = json({ session_id: 1, streamer_id: 2, accepted: 2, audio_state: "receiving" });
    const fetch = mockFetch(() => answer);
    const { d } = deps();
    const m = createTabAudioManager(d);
    await m.start(7, "https://kick.com/KickStar");

    let s = await m.onSamples(samples);
    expect(s).toMatchObject({ status: "measuring", levelDb: -24.5, lastSentAt: NOW.toISOString(), message: null });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/api/v1/monitoring/audio");
    expect(JSON.parse(String(init?.body))).toEqual({ platform: "kick", channel: "kickstar", sent_at: NOW.toISOString(), samples });

    answer = json({ error: { code: "not_monitoring", message: "kickstar has no active monitoring session" } }, 404);
    s = await m.onSamples(samples);
    expect(s).toMatchObject({ status: "waiting", message: "kickstar has no active monitoring session" });

    answer = null as unknown as Response; // network failure
    mockFetch(() => null);
    s = await m.onSamples(samples);
    expect(s).toMatchObject({ status: "error", message: "Backend not reachable; still measuring." });

    mockFetch(() => json({ error: { code: "unauthorized", message: "Sign in" } }, 401));
    s = await m.onSamples(samples);
    expect(s).toMatchObject({ status: "off", message: "Sign in to StreamHunter to use tab audio." });
    expect(d.closeOffscreen).toHaveBeenCalled();
  });

  it("sends the tab's audio only when sound detection is on, and keeps what the backend heard", async () => {
    await setAuthToken("tok");
    const fetch = mockFetch(() =>
      json({ session_id: 1, streamer_id: 2, accepted: 2, audio_state: "receiving", sound_state: "receiving", sounds: { laughter: 0.9, cheering: 0.1, screaming: 0 } }),
    );
    const pcm = { start: "2026-11-16T11:59:54.000Z", data: "AAEAAQ==" };
    const { d, offscreen } = deps();
    const m = createTabAudioManager(d);

    await m.start(7, "https://kick.com/kickstar"); // loudness only
    await m.onSamples(samples, pcm);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).pcm).toBeUndefined();
    expect((await getTabAudioState()).heard).toBeNull();

    await m.start(7, "https://kick.com/kickstar", { sounds: true });
    expect(offscreen.at(-1)).toEqual({ target: "offscreen", type: "meter/start", streamId: "stream-123", sounds: true });
    const s = await m.onSamples([], pcm); // audio but no new loudness value still goes out
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body)).pcm).toEqual(pcm);
    expect(s).toMatchObject({ sounds: true, soundState: "receiving", heard: { laughter: 0.9 } });
  });

  it("ignores samples when off and stops when the tab closes or the capture ends", async () => {
    const fetch = mockFetch(() => json({}));
    const { d, offscreen } = deps();
    const m = createTabAudioManager(d);
    expect((await m.onSamples(samples)).status).toBe("off");
    expect(fetch).not.toHaveBeenCalled();

    await m.start(7, "https://kick.com/kickstar");
    await m.onTabRemoved(99); // another tab
    expect((await getTabAudioState()).status).toBe("measuring");
    await m.onTabRemoved(7);
    expect(await getTabAudioState()).toMatchObject({ status: "off", message: "The measured tab was closed." });
    expect(offscreen.at(-1)).toEqual({ target: "offscreen", type: "meter/stop" });

    await m.start(7, "https://kick.com/kickstar");
    expect((await m.onEnded("The tab stopped sharing audio")).message).toBe("The tab stopped sharing audio");
    await m.start(7, "https://kick.com/kickstar");
    await m.reset();
    expect((await getTabAudioState()).status).toBe("off");
  });

  it("is reachable through worker messages, which validate their input", async () => {
    mockFetch(() => json({ session_id: 1, streamer_id: 2, accepted: 1, audio_state: "receiving" }));
    const { d } = deps();
    const tabAudio = createTabAudioManager(d);
    const manager = createMonitoringManager();
    expect(await handleMessage({ type: "tab-audio/start", tabId: "x", url: "https://kick.com/a" }, manager, tabAudio)).toEqual({ ok: false, error: "Invalid tab" });
    expect(await handleMessage({ type: "tab-audio/start", tabId: 3, url: "https://kick.com/a" }, manager, tabAudio)).toMatchObject({ ok: true, data: { status: "measuring" } });
    const fetch = mockFetch(() => json({ session_id: 1, streamer_id: 2, accepted: 1, audio_state: "receiving" }));
    await handleMessage({ type: "tab-audio/samples", samples: [{ t: "2026-11-16T12:00:00Z", db: Number.NaN }, { t: 5, db: 1 }, samples[0]] }, manager, tabAudio);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).samples).toEqual([samples[0]]);
    expect(await handleMessage({ type: "tab-audio/stop" }, manager)).toEqual({ ok: false, error: "Tab audio is only available in the installed extension" });
    expect(await handleMessage({ type: "tab-audio/get" }, manager)).toMatchObject({ ok: true, data: { status: "measuring" } });
  });
});
