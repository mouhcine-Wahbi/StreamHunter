import { db } from "@/local/db";
import { listHighlights } from "@/local/highlights";
import { TWITCH_USER_KEY } from "@/platforms/twitch-user";
import { ChatSim } from "@/test/chat-sim";
import { json, mockFetch } from "@/test/http";
import { configurePlatforms } from "@/test/platforms";
import type { MonitoringSession, Streamer } from "@/types/api";
import { ACTIVITY_KEY, createChatManager, KICK_CHAT_REASON, SIGN_IN_REASON } from "./chat-manager";

class FakeSocket {
  static all: FakeSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
    this.onclose?.();
  }
  send(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const streamer = (id: number, platform: "twitch" | "kick", login: string): Streamer => ({
  id, platform, platform_user_id: String(100 + id), username: login, display_name: login, profile_image_url: null, is_live: true,
  current_title: null, current_category: null, viewer_count: 10, stream_started_at: "2026-11-15T11:00:00Z", status_checked_at: null,
  monitoring_enabled: true, is_favorite: false, updated_at: "2026-11-15T11:00:00Z",
});

const session = (id: number, streamerId: number, platform: "twitch" | "kick"): MonitoringSession => ({
  id, streamer_id: streamerId, streamer_display_name: null, platform, broadcast_started_at: "2026-11-15T11:00:00Z",
  started_at: "2026-11-15T11:00:00Z", ended_at: null, status: "active", last_checked_at: null, last_event_at: null, error_message: null,
});

async function setup(signedIn = true) {
  FakeSocket.all = [];
  await configurePlatforms();
  if (signedIn) await chrome.storage.local.set({ [TWITCH_USER_KEY]: { token: "user-token", userId: "999", login: "editor", scopes: ["user:read:chat"], expiresAt: null } });
  await db.put("streamers", streamer(1, "twitch", "alpha"));
  await db.put("streamers", streamer(2, "kick", "kk"));
  await db.put("sessions", session(1, 1, "twitch"));
  await db.put("sessions", session(2, 2, "kick"));
  const subs: unknown[] = [];
  const fetch = mockFetch((url, init) => {
    if (url.startsWith("https://api.twitch.tv/helix/eventsub/subscriptions") && init?.method === "POST") {
      subs.push({ body: JSON.parse(String(init.body)), headers: init.headers });
      return json({ data: [{ id: "sub-1", status: "enabled" }] }, 202);
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return null;
  });
  const sim = new ChatSim();
  const highlights: unknown[] = [];
  const chat = createChatManager({
    now: () => sim.now,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    fetchImpl: (...a) => globalThis.fetch(...a),
    onHighlight: (h) => void highlights.push(h),
  });
  return { chat, sim, subs, fetch, highlights };
}

const activity = async () => (await chrome.storage.local.get(ACTIVITY_KEY))[ACTIVITY_KEY] as Record<string, { chat_state: string; chat_reason: string | null; messages_per_minute?: number }>;

describe("chat manager (Twitch EventSub WebSocket, in the extension)", () => {
  afterEach(() => vi.useRealTimers());

  it("subscribes to chat for live Twitch sessions and turns a reaction wave into a provisional highlight", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { chat, sim, subs, highlights } = await setup();
    await chat.sync();
    const [ws] = FakeSocket.all;
    expect(ws!.url).toBe("wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=10");
    ws!.send({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "S1" } } });
    await vi.waitFor(() => expect(subs).toHaveLength(1));
    expect(subs[0]).toMatchObject({
      body: { type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: "101", user_id: "999" }, transport: { method: "websocket", session_id: "S1" } },
      headers: { Authorization: "Bearer user-token", "Client-Id": "tw-client" },
    });

    // Feed chat as Twitch delivers it, evaluating every 5 s like the worker does.
    const msgs = [...sim.normal(180), ...sim.burst(12, 40, "KEKW", ["KEKW"]), ...sim.normal(60)].sort((a, b) => a.at - b.at);
    const end = sim.now;
    let i = 0;
    for (let t = msgs[0]!.at; t <= end; t += 5000) {
      sim.now = t;
      while (i < msgs.length && msgs[i]!.at < t) {
        const m = msgs[i++]!;
        ws!.send({
          metadata: { message_type: "notification", subscription_type: "channel.chat.message" },
          payload: { event: { broadcaster_user_id: "101", chatter_user_id: m.userId, chatter_user_login: m.userLogin,
            message: { text: m.text, fragments: m.emotes.map((e) => ({ type: "emote", text: e })) } } },
        });
      }
      await chat.evaluate();
    }
    const [h, ...rest] = await listHighlights();
    expect(rest).toEqual([]);
    expect(h).toMatchObject({ streamer_id: 1, session_id: 1, origin: "chat", category: "funny_moment", has_video: false, status: "pending_review" });
    expect(h!.reasons.some((r) => r.includes("'KEKW' used by"))).toBe(true);
    expect(h!.signal_breakdown).toMatchObject({ provisional: true, active_signals: ["chat"] });
    expect(highlights).toHaveLength(1);

    const a = await activity();
    expect(a["1"]).toMatchObject({ chat_state: "connected", chat_reason: null });
    expect(a["2"]).toEqual({ chat_state: "unavailable", chat_reason: KICK_CHAT_REASON });
  });

  it("explains that chat needs a Twitch sign-in, and opens no socket without one", async () => {
    const { chat } = await setup(false);
    await chat.sync();
    expect(FakeSocket.all).toEqual([]);
    expect((await activity())["1"]).toEqual({ chat_state: "unavailable", chat_reason: SIGN_IN_REASON });
  });

  it("unsubscribes and closes the socket when the stream ends", async () => {
    const { chat, fetch } = await setup();
    await chat.sync();
    FakeSocket.all[0]!.send({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "S1" } } });
    await vi.waitFor(() => expect(chat.tracked.get(1)?.subscriptionId).toBe("sub-1"));
    await db.put("sessions", { ...session(1, 1, "twitch"), status: "ended" });
    await chat.sync();
    expect(FakeSocket.all[0]!.closed).toBe(true);
    expect(fetch.mock.calls.some(([u, init]) => String(u).endsWith("/eventsub/subscriptions?id=sub-1") && init?.method === "DELETE")).toBe(true);
  });

  it("reports a refused subscription", async () => {
    const { chat } = await setup();
    const refused = mockFetch(() => json({ message: "missing scope" }, 403));
    await chat.sync();
    FakeSocket.all[0]!.send({ metadata: { message_type: "session_welcome" }, payload: { session: { id: "S1" } } });
    await vi.waitFor(() => expect(refused).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    await chat.evaluate();
    expect((await activity())["1"]).toMatchObject({ chat_state: "unavailable", chat_reason: expect.stringMatching(/sign in with Twitch again/) });
  });
});
