import { StreamAnalyzer, strictnessFor, type CandidateDraft } from "@/detection/analyzer";
import { db } from "@/local/db";
import { createHighlight, type LocalHighlight } from "@/local/highlights";
import { getCredentials } from "@/platforms/credentials";
import { getTwitchUser } from "@/platforms/twitch-user";
import { getSettings } from "@/store/storage";
import type { MonitoringSession, Streamer } from "@/types/api";

/**
 * Discovery-mode chat detection, in the service worker.
 *
 * Twitch: one EventSub WebSocket (wss://eventsub.wss.twitch.tv) carries `channel.chat.message`
 * for every live Twitch streamer on the monitoring list, with the editor's own Twitch sign-in.
 * Chrome keeps the worker alive while the socket exchanges messages (keepalive every 10 s).
 * Kick: chat is only delivered to servers (webhooks), so Kick sessions report "unavailable".
 *
 * Messages are analysed in memory and dropped; only highlights (provisional: no video) are stored.
 */
export const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=10";
export const ACTIVITY_KEY = "sh.chatActivity";
const EVALUATE_EVERY_MS = 5_000;

export const KICK_CHAT_REASON = "Kick delivers chat only to servers (webhooks), so StreamHunter can't read it from the browser.";
export const SIGN_IN_REASON = "Sign in with Twitch (Settings → Platforms) to read chat.";

export interface ChatDeps {
  now: () => number;
  createSocket: (url: string) => WebSocket;
  fetchImpl: typeof fetch;
  /** Called for every stored highlight (notifications, capture clips). */
  onHighlight: (h: LocalHighlight, streamer: Streamer) => Promise<void> | void;
}

interface Tracked {
  streamer: Streamer;
  session: MonitoringSession;
  analyzer: StreamAnalyzer;
  subscriptionId: string | null;
}

export type ChatActivity = Record<string, { chat_state: "connected" | "connecting" | "unavailable"; chat_reason: string | null; [k: string]: unknown }>;

export function createChatManager(deps: ChatDeps) {
  const tracked = new Map<number, Tracked>();
  const unavailable = new Map<number, string>(); // streamer id → reason
  let ws: WebSocket | null = null;
  let sessionId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let syncing: Promise<void> | null = null;

  async function helix(method: string, path: string, body?: unknown): Promise<Response> {
    const [user, creds] = await Promise.all([getTwitchUser(), getCredentials()]);
    if (!user || !creds.twitch) throw new Error(SIGN_IN_REASON);
    return deps.fetchImpl(`https://api.twitch.tv/helix${path}`, {
      method,
      headers: { Authorization: `Bearer ${user.token}`, "Client-Id": creds.twitch.clientId, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function subscribe(t: Tracked): Promise<void> {
    const user = await getTwitchUser();
    if (!sessionId || !user) return;
    const res = await helix("POST", "/eventsub/subscriptions", {
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: t.streamer.platform_user_id, user_id: user.userId },
      transport: { method: "websocket", session_id: sessionId },
    });
    if (res.status === 202 || res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
      t.subscriptionId = body.data?.[0]?.id ?? "subscribed";
      unavailable.delete(t.streamer.id);
    } else if (res.status !== 409) {
      unavailable.set(t.streamer.id, res.status === 401 || res.status === 403
        ? "Twitch refused chat access: sign in with Twitch again in Settings."
        : `Twitch refused the chat subscription (HTTP ${res.status}).`);
    }
  }

  function onMessage(raw: string) {
    let m: { metadata?: { message_type?: string; subscription_type?: string }; payload?: Record<string, unknown> };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const type = m.metadata?.message_type;
    if (type === "session_welcome" || type === "session_reconnect") {
      const s = (m.payload?.session ?? {}) as { id?: string; reconnect_url?: string };
      if (type === "session_reconnect" && s.reconnect_url) {
        connect(s.reconnect_url); // subscriptions move with the session
        return;
      }
      sessionId = s.id ?? null;
      for (const t of tracked.values()) t.subscriptionId = null;
      void Promise.all([...tracked.values()].map((t) => subscribe(t).catch(() => undefined)));
      return;
    }
    if (type === "notification" && m.metadata?.subscription_type === "channel.chat.message") {
      const e = (m.payload?.event ?? {}) as {
        broadcaster_user_id?: string; chatter_user_id?: string; chatter_user_login?: string;
        message?: { text?: string; fragments?: { type?: string; text?: string }[] };
      };
      const t = [...tracked.values()].find((x) => x.streamer.platform_user_id === e.broadcaster_user_id);
      if (!t || !e.chatter_user_id) return;
      t.analyzer.add({
        userId: e.chatter_user_id,
        userLogin: e.chatter_user_login ?? e.chatter_user_id,
        text: e.message?.text ?? "",
        emotes: (e.message?.fragments ?? []).filter((f) => f.type === "emote" && f.text).map((f) => f.text!),
        at: deps.now(),
      });
    }
    if (type === "revocation") {
      const sub = (m.payload?.subscription ?? {}) as { id?: string; condition?: { broadcaster_user_id?: string } };
      const t = [...tracked.values()].find((x) => x.subscriptionId === sub.id);
      if (t) {
        t.subscriptionId = null;
        unavailable.set(t.streamer.id, "Twitch ended the chat subscription (permission revoked or channel unavailable).");
      }
    }
  }

  function connect(url = EVENTSUB_URL) {
    const old = ws;
    const next = deps.createSocket(url);
    ws = next;
    next.onmessage = (ev) => onMessage(String(ev.data));
    next.onclose = () => {
      if (ws !== next) return; // replaced by a reconnect
      ws = null;
      sessionId = null;
      for (const t of tracked.values()) t.subscriptionId = null;
    };
    if (old && url !== EVENTSUB_URL) {
      // Twitch's reconnect flow: close the old socket once the new one is welcomed.
      next.addEventListener?.("message", () => old.close(), { once: true });
    }
    timer ??= setInterval(() => void evaluate(), EVALUATE_EVERY_MS);
  }

  function disconnect() {
    const s = ws;
    ws = null;
    sessionId = null;
    s?.close();
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function persist(t: Tracked, draft: CandidateDraft): Promise<void> {
    const settings = await getSettings();
    if (draft.strictness < strictnessFor(settings.detection.sensitivity)) return;
    const h = await createHighlight({
      streamer: t.streamer,
      session: t.session,
      origin: "chat",
      peakAt: draft.peakAt,
      startAt: draft.startAt - settings.clips.preRollSeconds * 1000,
      endAt: draft.endAt + settings.clips.postRollSeconds * 1000,
      score: draft.score,
      confidence: draft.confidence,
      category: draft.category,
      reasons: draft.reasons,
      breakdown: { chat: draft.chat, audio: null, visual: null, context: null, active_signals: ["chat"], detectors: draft.detectors, provisional: true },
    });
    await db.put("sessions", { ...t.session, last_event_at: new Date(deps.now()).toISOString() });
    await deps.onHighlight(h, t.streamer);
  }

  async function evaluate(): Promise<void> {
    const now = deps.now();
    for (const t of tracked.values()) {
      const draft = t.analyzer.evaluate(now);
      if (draft) await persist(t, draft).catch(() => undefined);
    }
    await writeActivity();
  }

  async function writeActivity(): Promise<void> {
    const now = deps.now();
    const out: ChatActivity = {};
    for (const [id, reason] of unavailable) out[id] = { chat_state: "unavailable", chat_reason: reason };
    for (const t of tracked.values()) {
      if (unavailable.has(t.streamer.id)) continue;
      out[t.streamer.id] = {
        chat_state: t.subscriptionId ? "connected" : "connecting",
        chat_reason: null,
        ...t.analyzer.activity(now),
      };
    }
    await chrome.storage.local.set({ [ACTIVITY_KEY]: out });
  }

  /** Match the chat connection to the active sessions (call after every status check). */
  async function runSync(): Promise<void> {
    const [sessions, streamers, user, settings] = await Promise.all([
      db.all<MonitoringSession>("sessions"),
      db.all<Streamer>("streamers"),
      getTwitchUser(),
      getSettings(),
    ]);
    const active = sessions.filter((s) => s.status === "active");
    const want = new Map<number, { streamer: Streamer; session: MonitoringSession }>();
    unavailable.clear();
    for (const s of active) {
      const st = streamers.find((x) => x.id === s.streamer_id);
      if (!st) continue;
      if (st.platform === "kick") unavailable.set(st.id, KICK_CHAT_REASON);
      else if (!user) unavailable.set(st.id, SIGN_IN_REASON);
      else want.set(st.id, { streamer: st, session: s });
    }
    // Stop following streamers that went offline.
    for (const [id, t] of tracked) {
      if (want.has(id)) continue;
      const draft = t.analyzer.flush();
      if (draft) await persist(t, draft).catch(() => undefined);
      if (t.subscriptionId && t.subscriptionId !== "subscribed")
        await helix("DELETE", `/eventsub/subscriptions?id=${encodeURIComponent(t.subscriptionId)}`).catch(() => undefined);
      tracked.delete(id);
    }
    for (const [id, w] of want) {
      let t = tracked.get(id);
      if (!t) {
        t = { ...w, analyzer: new StreamAnalyzer(w.streamer.username), subscriptionId: null };
        tracked.set(id, t);
      }
      t.session = w.session;
      t.analyzer.configure(settings.detection.keywordLanguages, settings.detection.customKeywords);
    }
    if (tracked.size === 0) disconnect();
    else if (!ws) connect();
    else await Promise.all([...tracked.values()].filter((t) => !t.subscriptionId).map((t) => subscribe(t).catch(() => undefined)));
    await writeActivity();
  }

  function sync(): Promise<void> {
    syncing ??= runSync().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  return { sync, evaluate, disconnect, get connected() { return ws !== null; }, get tracked() { return tracked; } };
}

export type ChatManager = ReturnType<typeof createChatManager>;
