import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";
import { Popup } from "@/popup/Popup";
import { SidePanel } from "@/sidepanel/SidePanel";
import { createMonitoringManager } from "@/background/monitoring-manager";
import { handleMessage } from "@/background/message-handler";
import { getSettings } from "@/store/storage";
import { json, mockFetch } from "@/test/http";

/** Wires runtime messages to the real handler, as the service worker would. */
function installWorker() {
  const manager = createMonitoringManager();
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    handleMessage(msg, manager).then(respond);
    return true;
  });
}

describe("popup", () => {
  it("renders status and starts monitoring via the background worker", async () => {
    mockFetch((url) =>
      /\/(heartbeat|start)$/.test(url)
        ? json({ lease_expires_at: "2026-11-13T10:06:00Z", interval_seconds: 120, started: true, active_sessions: 0, live_count: 0, notifications: [], server_time: "2026-11-13T10:00:00Z" })
        : json({ detail: "Not Found" }, 404),
    );
    installWorker();
    render(<Popup />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /start monitoring/i }));
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /stop monitoring/i })).toBeInTheDocument();
  });

  it("tells the user when the backend is unreachable instead of showing fake data", async () => {
    mockFetch(() => null);
    installWorker();
    render(<Popup />);
    expect(await screen.findByText("Backend not reachable")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("opens the full workspace", async () => {
    mockFetch(() => null);
    installWorker();
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    render(<Popup />);
    await userEvent.click(screen.getByRole("button", { name: /open workspace/i }));
    await waitFor(() => expect(fakeChrome.internals.createdTabs).toHaveLength(1));
    expect(close).toHaveBeenCalled();
  });
});

describe("popup tab audio (Phase 7)", () => {
  function workerWithTabAudio(onStart: (msg: { tabId: number; url: string }) => void) {
    chrome.runtime.onMessage.addListener((msg: unknown, _sender, respond) => {
      const m = msg as { type: string; tabId: number; url: string };
      if (m.type === "tab-audio/start") {
        onStart(m);
        const state = { status: "measuring", tabId: m.tabId, platform: "twitch", channel: "streamerone", startedAt: "2026-11-16T12:00:00Z",
          lastSentAt: null, levelDb: null, message: "Measuring… the first values arrive within a few seconds." };
        void chrome.storage.local.set({ "sh.tabAudio": state }).then(() => respond({ ok: true, data: state }));
        return true;
      }
      if (m.type === "tab-audio/stop") {
        const state = { status: "off", tabId: null, platform: null, channel: null, startedAt: null, lastSentAt: null, levelDb: null, message: null };
        void chrome.storage.local.set({ "sh.tabAudio": state }).then(() => respond({ ok: true, data: state }));
        return true;
      }
      return false;
    });
  }

  it("offers to measure a Twitch channel tab, then shows the live level and stops", async () => {
    mockFetch(() => json({ detail: "Not Found" }, 404));
    fakeChrome.internals.setActiveTab({ id: 42, url: "https://www.twitch.tv/StreamerOne" });
    const starts: unknown[] = [];
    workerWithTabAudio((m) => starts.push(m));
    render(<Popup />);
    await userEvent.click(await screen.findByRole("button", { name: "Measure this tab's audio (streamerone)" }));
    expect(starts).toEqual([{ type: "tab-audio/start", tabId: 42, url: "https://www.twitch.tv/StreamerOne", sounds: false }]);
    expect(await screen.findByText("Measuring")).toBeInTheDocument();
    expect(screen.getByText("twitch.tv/streamerone")).toBeInTheDocument();

    // The worker updates the level as batches are delivered.
    await act(async () => {
      await chrome.storage.local.set({ "sh.tabAudio": { status: "waiting", tabId: 42, platform: "twitch", channel: "streamerone", startedAt: "2026-11-16T12:00:00Z",
        lastSentAt: null, levelDb: -23.4, message: "streamerone has no active monitoring session" } });
    });
    expect(screen.getByText("Not monitored")).toBeInTheDocument();
    expect(screen.getByText(/· -23 dB/)).toBeInTheDocument();
    expect(screen.getByText("streamerone has no active monitoring session")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Stop measuring" }));
    expect(await screen.findByRole("button", { name: "Measure this tab's audio (streamerone)" })).toBeInTheDocument();
  });

  it("can also listen for laughter (opt-in) and shows what it hears", async () => {
    mockFetch(() => json({ detail: "Not Found" }, 404));
    fakeChrome.internals.setActiveTab({ id: 42, url: "https://www.twitch.tv/StreamerOne" });
    const starts: unknown[] = [];
    workerWithTabAudio((m) => starts.push(m));
    render(<Popup />);
    await userEvent.click(await screen.findByRole("checkbox", { name: /Also detect laughter and cheering/ }));
    await userEvent.click(screen.getByRole("button", { name: "Measure this tab's audio (streamerone)" }));
    expect(starts).toEqual([{ type: "tab-audio/start", tabId: 42, url: "https://www.twitch.tv/StreamerOne", sounds: true }]);
    await act(async () => {
      await chrome.storage.local.set({ "sh.tabAudio": { status: "measuring", tabId: 42, platform: "twitch", channel: "streamerone",
        startedAt: "2026-11-16T12:00:00Z", lastSentAt: null, levelDb: -20, message: null, sounds: true, soundState: "receiving",
        heard: { laughter: 0.8, cheering: 0.1, screaming: 0 } } });
    });
    expect(screen.getByText("Hearing laughter 80%")).toBeInTheDocument();
  });

  it("explains what to do on other pages", async () => {
    mockFetch(() => json({ detail: "Not Found" }, 404));
    fakeChrome.internals.setActiveTab({ id: 1, url: "https://www.youtube.com/" });
    render(<Popup />);
    expect(await screen.findByText(/Open a Twitch or Kick channel in this tab/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Measure this tab/ })).not.toBeInTheDocument();
  });
});

describe("full page app", () => {
  it("navigates between all sections", async () => {
    mockFetch(() => null);
    installWorker();
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const [link, heading] of [
      ["Discover", "Discover"],
      ["My Streamers", "My Streamers"],
      ["Live Monitoring", "Live Monitoring"],
      ["Highlights", "Highlights"],
      ["Clip Library", "Clip Library"],
      ["Settings", "Settings"],
      ["Overview", "Overview"],
    ] as const) {
      await userEvent.click(within(nav).getByRole("link", { name: link }));
      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
      expect(within(nav).getByRole("link", { name: link })).toHaveAttribute("aria-current", "page");
    }
  });

  it("persists settings changes to chrome.storage", async () => {
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    await userEvent.click(screen.getByRole("radio", { name: "High" }));
    const interval = screen.getByLabelText("Check interval");
    await userEvent.clear(interval);
    await userEvent.type(interval, "7{Enter}");
    await userEvent.click(screen.getByRole("switch", { name: "Streamer goes live" }));
    await waitFor(async () => {
      const s = await getSettings();
      expect(s.detection.sensitivity).toBe("high");
      expect(s.monitoring.intervalMinutes).toBe(7);
      expect(s.notifications.onStreamerLive).toBe(true);
    });
  });

  it("validates the backend URL", async () => {
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    const input = await screen.findByLabelText("Backend URL");
    await userEvent.clear(input);
    await userEvent.type(input, "http://example.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/http is only allowed for localhost/)).toBeInTheDocument();
    expect((await getSettings()).backendUrl).toBe("http://localhost:8000");
  });

  it("shows real search results from the backend", async () => {
    mockFetch((url) =>
      url.includes("/api/v1/streamers/search?platform=kick&username=somechannel")
        ? json([
            {
              platform: "kick",
              platform_user_id: "42",
              username: "somechannel",
              display_name: "SomeChannel",
              profile_image_url: null,
              is_live: true,
              current_title: "Late night",
              current_category: "Just Chatting",
            },
          ])
        : null,
    );
    installWorker();
    window.location.hash = "/discover";
    render(<App />);
    await userEvent.click(await screen.findByRole("radio", { name: "Kick" }));
    await userEvent.type(screen.getByLabelText("Channel name"), "somechannel");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("SomeChannel")).toBeInTheDocument();
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByText(/Just Chatting/)).toBeInTheDocument();
  });
});

describe("side panel", () => {
  it("renders the highlight feed state", async () => {
    mockFetch((url) => (url.includes("/api/v1/highlights") ? json({ items: [], total: 0, limit: 30, offset: 0 }) : null));
    installWorker();
    render(<SidePanel />);
    expect(await screen.findByText("Nothing to review yet")).toBeInTheDocument();
  });
});

describe("account (Phase 2)", () => {
  const user = { id: 1, email: "ed@example.com", username: "ed", created_at: "2026-11-15T00:00:00Z" };

  it("signs in, stores only the StreamHunter session token, and signs out", async () => {
    const fetch = mockFetch((url, init) => {
      if (url.endsWith("/api/v1/auth/login")) return json({ access_token: "sess-123", expires_at: "2026-12-01T00:00:00Z", user });
      if (url.endsWith("/api/v1/auth/logout")) return new Response(null, { status: 204 });
      if (url.endsWith("/api/v1/auth/me")) {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        return auth === "Bearer sess-123" ? json(user) : json({ error: { code: "invalid_session", message: "x" } }, 401);
      }
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Email"), "ed@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "a long password");
    await userEvent.click(within(screen.getByRole("form", { name: "StreamHunter account" })).getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("ed@example.com")).toBeInTheDocument();
    expect(fakeChrome.internals.store["sh.authToken"]).toBe("sess-123");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(fakeChrome.internals.store["sh.authToken"]).toBeUndefined());
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/api/v1/auth/logout"))).toBe(true);
  });

  it("shows field errors from registration", async () => {
    mockFetch((url) =>
      url.endsWith("/api/v1/auth/register")
        ? json({ error: { code: "email_taken", message: "An account with this email already exists", details: null } }, 409)
        : json({ detail: "Not Found" }, 404),
    );
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    await userEvent.click(await screen.findByRole("radio", { name: "Create account" }));
    await userEvent.type(screen.getByLabelText("Email"), "ed@example.com");
    await userEvent.type(screen.getByLabelText("Username"), "ed");
    await userEvent.type(screen.getByLabelText("Password"), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("An account with this email already exists")).toBeInTheDocument();
  });

  it("asks to sign in when the backend answers 401", async () => {
    mockFetch(() => json({ error: { code: "not_authenticated", message: "Authentication required" } }, 401));
    installWorker();
    window.location.hash = "/streamers";
    render(<App />);
    expect(await screen.findByText("Sign-in required")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  });

  it("treats 'already in watchlist' as added and shows platform-not-configured clearly", async () => {
    mockFetch((url, init) => {
      if (url.includes("/streamers/search?platform=twitch")) {
        return json([{ platform: "twitch", platform_user_id: "1", username: "alpha", display_name: "Alpha", profile_image_url: null, is_live: false, current_title: null, current_category: null }]);
      }
      if (url.includes("/streamers/search?platform=kick")) {
        return json({ error: { code: "platform_not_configured", message: "Kick is not configured on the backend (KICK_CLIENT_ID / KICK_CLIENT_SECRET)." } }, 503);
      }
      if (url.endsWith("/api/v1/streamers") && init?.method === "POST") {
        return json({ error: { code: "already_in_watchlist", message: "already", details: { streamer_id: 1 } } }, 409);
      }
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/discover";
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Channel name"), "alpha");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByRole("button", { name: "In watchlist" })).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: "Kick" }));
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Not available yet")).toBeInTheDocument();
    expect(screen.getByText(/Kick is not configured on the backend/)).toBeInTheDocument();
  });
});

describe("platform connections & status (Phase 3)", () => {
  const caps = (configured: boolean) => [
    { platform: "twitch", configured, connection_status: "not_connected", capabilities: { stream_lookup: configured ? "supported" : "requires_configuration" }, notes: [] },
  ];

  it("opens the platform consent page in a new tab", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/v1/platforms/capabilities")) return json(caps(true));
      if (url.endsWith("/api/v1/auth/twitch/status")) return json({ platform: "twitch", configured: true, connection_status: "not_connected", platform_username: null, scopes: [], last_error: null });
      if (url.endsWith("/api/v1/auth/twitch/authorize")) return json({ authorization_url: "https://id.twitch.tv/oauth2/authorize?client_id=x&state=s", expires_at: "2026-11-15T07:00:00Z" });
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect account" }));
    await waitFor(() => expect(fakeChrome.internals.createdTabs).toEqual(["https://id.twitch.tv/oauth2/authorize?client_id=x&state=s"]));
  });

  it("refuses to open an unexpected authorization host", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/v1/platforms/capabilities")) return json(caps(true));
      if (url.endsWith("/status")) return json({ platform: "twitch", configured: true, connection_status: "not_connected", platform_username: null, scopes: [], last_error: null });
      if (url.endsWith("/authorize")) return json({ authorization_url: "https://evil.example/phish", expires_at: "x" });
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect account" }));
    expect(await screen.findByText("Unexpected authorization URL")).toBeInTheDocument();
    expect(fakeChrome.internals.createdTabs).toEqual([]);
  });

  it("shows the connected account and disables connect when the backend is not configured", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/v1/platforms/capabilities")) return json(caps(false));
      if (url.endsWith("/status")) return json({ platform: "twitch", configured: false, connection_status: "not_connected", platform_username: null, scopes: [], last_error: null });
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    expect(await screen.findByRole("button", { name: "Connect account" })).toBeDisabled();
    expect(screen.getByText("not configured")).toBeInTheDocument();
  });

  it("refreshes watchlist status and reports platform problems", async () => {
    const page = { items: [], total: 0, limit: 100, offset: 0 };
    mockFetch((url, init) => {
      if (url.endsWith("/api/v1/streams/refresh") && init?.method === "POST")
        return json({ checked: 3, live: 1, skipped_recent: 0, unavailable: { kick: "Kick is not configured on the backend." } });
      if (url.includes("/api/v1/streamers")) return json(page);
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/streamers";
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText(/Checked 3, 1 live\. kick: Kick is not configured/)).toBeInTheDocument();
  });
});


describe("chat intelligence UI (Phase 5)", () => {
  it("shows chat state, activity and unavailable reasons per active session", async () => {
    const sessions = {
      items: [
        { id: 1, streamer_id: 3, streamer_display_name: "Alpha", platform: "twitch", started_at: "2026-11-15T12:00:00Z", ended_at: null, status: "active", last_checked_at: null, last_event_at: null, error_message: null, broadcast_started_at: null },
        { id: 2, streamer_id: 4, streamer_display_name: "Kickstar", platform: "kick", started_at: "2026-11-15T12:00:00Z", ended_at: null, status: "active", last_checked_at: null, last_event_at: null, error_message: null, broadcast_started_at: null },
      ],
      total: 2, limit: 50, offset: 0,
    };
    mockFetch((url) => {
      if (url.endsWith("/api/v1/monitoring/1/activity"))
        return json({ chat_state: "connected", chat_reason: null, messages_per_minute: 42, unique_chatters_per_minute: 17, baseline_messages_per_minute: 20.5, warming_up: false, series: [1, 2, 3], active_signals: ["chat_spike"] });
      if (url.endsWith("/api/v1/monitoring/2/activity"))
        return json({ chat_state: "unavailable", chat_reason: "Kick chat needs a public HTTPS webhook URL." });
      if (url.includes("/api/v1/monitoring?")) return json(sessions);
      if (url.includes("/api/v1/streams/live")) return json({ items: [], total: 0, limit: 50, offset: 0 });
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/monitoring";
    render(<App />);
    expect(await screen.findByText("Chat connected")).toBeInTheDocument();
    expect(screen.getByText(/42\/min · 17 chatters · normal 20.5\/min/)).toBeInTheDocument();
    expect(screen.getByText("chat spike")).toBeInTheDocument();
    expect(await screen.findByText("Chat unavailable")).toBeInTheDocument();
    expect(screen.getByText(/public HTTPS webhook URL/)).toBeInTheDocument();
  });

  it("explains highlights with reasons, confidence and signals", async () => {
    mockFetch((url) =>
      url.includes("/api/v1/highlights")
        ? json({ items: [{ id: 9, streamer_id: 3, streamer_display_name: "Alpha", platform: "twitch", timestamp: "2026-11-15T12:30:00Z",
            start_offset_sec: 1790, end_offset_sec: 1840, score: 84, confidence: 0.93, category: "funny_moment",
            reasons: ["'KEKW' used by 40 chatters (85% of chat)", "Chat activity 4.2× its normal level (52 chatters in 15 s)"],
            signal_breakdown: { chat: 84, audio: null, visual: null, context: null }, status: "pending_review" }], total: 1, limit: 50, offset: 0 })
        : json({ detail: "Not Found" }, 404),
    );
    installWorker();
    window.location.hash = "/highlights";
    render(<App />);
    expect(await screen.findByText("'KEKW' used by 40 chatters (85% of chat)")).toBeInTheDocument();
    expect(screen.getByText(/Confidence 93% · signals: chat 84 · audio and video not analysed yet · offsets approximate/)).toBeInTheDocument();
    expect(screen.getByText(/Funny moment/)).toBeInTheDocument();
    expect(screen.getByText(/≈0:29:50 into stream/)).toBeInTheDocument();
  });
});

describe("review & clip workflow (Phase 6)", () => {
  const baseHighlight = {
    id: 5, session_id: 1, streamer_id: 3, streamer_display_name: "Alpha", streamer_username: "alpha", platform: "twitch",
    timestamp: "2026-11-15T12:30:00Z", start_offset_sec: 100, end_offset_sec: 140, score: 84, confidence: 0.9,
    category: "funny_moment", reasons: ["'KEKW' used by 40 chatters"], signal_breakdown: { chat: 84, audio: null },
  };
  const page = (items: unknown[]) => ({ items, total: items.length, limit: 50, offset: 0 });
  const clip = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 11, candidate_id: 5, platform: "twitch", platform_clip_id: null, platform_clip_url: null, local_file_path: null,
    title: null, duration_seconds: 40, aspect_ratio: "9:16", status: "approved", error_message: null, source: "editor",
    edit_url: null, requested_at: null, request_lag_seconds: null, published_at: null, published_url: null,
    created_at: "2026-11-15T12:31:00Z", ...over,
  });

  it("approves a highlight and handles 'moment passed' with an explicit choice", async () => {
    let state: Record<string, unknown> = { ...baseHighlight, status: "pending_review", clip: null };
    const posts: { url: string; body: unknown }[] = [];
    mockFetch((url, init) => {
      if (init?.method === "POST") posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/api/v1/highlights/5/approve")) {
        state = { ...state, status: "approved", clip: { id: 11, status: "approved", platform_clip_url: null, error_message: null } };
        return json({ highlight: state, clip: clip() });
      }
      if (url.endsWith("/api/v1/clips/11/create")) {
        const body = JSON.parse(String(init!.body));
        if (!body.accept_current_moment)
          return json({ error: { code: "moment_passed", message: "This moment was 5 min 0 s ago. Confirm to capture the current broadcast instead." } }, 409);
        state = { ...state, clip: { id: 11, status: "created", platform_clip_url: "https://clips.twitch.tv/Clip1", error_message: null } };
        return json(clip({ status: "created", platform_clip_url: "https://clips.twitch.tv/Clip1" }));
      }
      if (url.includes("/api/v1/highlights")) return json(page([state]));
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/highlights";
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create Twitch clip" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Moment has passed" });
    expect(within(dialog).getByText(/5 min 0 s ago/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Capture current broadcast" }));
    expect(await screen.findByRole("link", { name: /Open clip/ })).toHaveAttribute("href", "https://clips.twitch.tv/Clip1");
    expect(posts.filter((p) => p.url.endsWith("/create")).map((p) => p.body)).toEqual([
      { accept_current_moment: false },
      { accept_current_moment: true },
    ]);
    expect(screen.getByRole("link", { name: /Open stream/ })).toHaveAttribute("href", "https://www.twitch.tv/alpha");
  });

  it("rejects and reopens", async () => {
    let status = "pending_review";
    mockFetch((url, init) => {
      if (url.endsWith("/reject")) {
        status = "rejected";
        return json({ highlight: { ...baseHighlight, status }, clip: null });
      }
      if (url.endsWith("/api/v1/highlights/5") && init?.method === "PATCH") {
        status = "pending_review";
        return json({ ...baseHighlight, status });
      }
      if (url.includes("/api/v1/highlights")) return json(page([{ ...baseHighlight, status, clip: null }]));
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/highlights";
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("clip library: manual Kick link, honest export, and confirmed publishing", async () => {
    let c = clip({ platform: "kick", status: "unsupported", error_message: "Kick has no clip API. Open https://kick.com/kickstar, create the clip there, then paste its URL here." });
    const calls: { url: string; method: string; body: unknown }[] = [];
    mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/api/v1/clips/11") && method === "PATCH") {
        c = { ...c, status: "created", source: "manual", platform_clip_url: "https://kick.com/kickstar/clips/clip_1" };
        return json(c);
      }
      if (url.endsWith("/api/v1/clips/11/export"))
        return json({ error: { code: "media_unavailable", message: "Export needs the video itself, and StreamHunter has no authorized media source for this clip." } }, 409);
      if (url.endsWith("/api/v1/clips/11/publish")) {
        c = { ...c, status: "published", published_at: "2026-11-15T13:00:00Z" };
        return json(c);
      }
      if (url.includes("/api/v1/clips")) return json(page([c]));
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/clips";
    render(<App />);
    expect(await screen.findByText(/Kick has no clip API/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark as published" })).toBeInTheDocument(); // manual clips may be published
    await userEvent.type(screen.getByLabelText("Clip URL"), "https://kick.com/kickstar/clips/clip_1");
    await userEvent.click(screen.getByRole("button", { name: "Save clip link" }));
    expect(await screen.findByRole("link", { name: /Platform clip/ })).toHaveAttribute("href", "https://kick.com/kickstar/clips/clip_1");

    await userEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    expect(await screen.findByText(/no authorized media source/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mark as published" }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm publishing" });
    expect(within(dialog).getByText(/does not post anything itself/)).toBeInTheDocument();
    expect(calls.some((x) => x.url.endsWith("/publish"))).toBe(false); // nothing until confirmed
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm: mark as published" }));
    await waitFor(() => expect(calls.find((x) => x.url.endsWith("/publish"))?.body).toEqual({ confirm: true }));
    expect(await screen.findByText("Published")).toBeInTheDocument();
  });

  it("settings: auto-capture toggle persists", async () => {
    mockFetch(() => json({ detail: "Not Found" }, 404));
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    const toggle = await screen.findByRole("switch", { name: "Capture Twitch clips automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    await waitFor(async () => expect((await getSettings()).clips.autoCreatePlatformClips).toBe(false));
  });
});

describe("recordings, VOD and export (Phase 7)", () => {
  const session = {
    id: 1, streamer_id: 3, streamer_display_name: "Alpha", platform: "twitch", started_at: "2026-11-15T10:00:00Z",
    ended_at: "2026-11-15T12:00:00Z", status: "ended", last_checked_at: null, last_event_at: null, error_message: null,
    broadcast_started_at: "2026-11-15T10:00:00Z", vod_id: null, vod_url: null,
  };
  const caps = { ffmpeg_available: true, max_upload_mb: 4096, media_folder: "/srv/media/library/1", supported_extensions: [".mp4"], subtitles: "requires_configuration", live_tab_audio: "not_implemented" };

  it("finds the VOD, uploads a recording with rights confirmation, and shows analysis results", async () => {
    let s: Record<string, unknown> = { ...session };
    let media: unknown[] = [];
    let jobPolls = 0;
    const uploads: FormData[] = [];
    mockFetch((url, init) => {
      if (url.endsWith("/api/v1/monitoring/1/vod")) {
        s = { ...s, vod_id: "v1", vod_url: "https://www.twitch.tv/videos/v1" };
        return json(s);
      }
      if (url.includes("/api/v1/monitoring?")) return json({ items: [s], total: 1, limit: 50, offset: 0 });
      if (url.includes("/api/v1/streams/live")) return json({ items: [], total: 0, limit: 50, offset: 0 });
      if (url.endsWith("/api/v1/media/capabilities")) return json(caps);
      if (url.endsWith("/api/v1/media/upload")) {
        uploads.push(init!.body as FormData);
        media = [{ id: 7, session_id: 1, kind: "upload", original_name: "vod.mp4", size_bytes: 10, duration_sec: 5400, has_audio: true, has_video: true, width: 1920, height: 1080, offset_in_stream_sec: 0, status: "ready", error_message: null, created_at: "x" }];
        return json(media[0], 201);
      }
      if (url.includes("/api/v1/media?session_id=1")) return json({ items: media, total: media.length, limit: 50, offset: 0 });
      if (url.endsWith("/api/v1/media/7/analyze")) return json({ id: 3, kind: "analyze", media_source_id: 7, clip_id: null, status: "queued", result: {}, error_message: null }, 202);
      if (url.endsWith("/api/v1/media/jobs/3")) {
        jobPolls++;
        return json({ id: 3, kind: "analyze", media_source_id: 7, clip_id: null, status: "succeeded", error_message: null,
          result: { audio_peaks: 4, scene_changes: 12, candidates_enriched: 3, candidates_created: 1, candidates_merged: 1 } });
      }
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/monitoring";
    render(<App />);
    await userEvent.click(await screen.findByText("Recording & analysis"));
    await userEvent.click(await screen.findByRole("button", { name: "Find Twitch VOD" }));
    expect(await screen.findByRole("link", { name: /Twitch VOD/ })).toHaveAttribute("href", "https://www.twitch.tv/videos/v1");

    const upload = screen.getByRole("button", { name: "Upload recording" });
    expect(upload).toBeDisabled(); // rights must be confirmed first
    await userEvent.upload(screen.getByLabelText("Recording file"), new File(["x"], "vod.mp4", { type: "video/mp4" }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(upload);
    expect(await screen.findByText("vod.mp4")).toBeInTheDocument();
    expect(uploads[0]!.get("rights_confirmed")).toBe("true");
    expect(uploads[0]!.get("session_id")).toBe("1");

    await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText(/4 audio peaks · 12 scene changes · 3 highlights enriched · 1 new highlights · 1 merged/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(jobPolls).toBeGreaterThan(0);
  });

  it("shows VOD deep links, recording-only highlights and measured signals", async () => {
    mockFetch((url) =>
      url.includes("/api/v1/highlights")
        ? json({ items: [{ id: 1, session_id: 1, streamer_id: 3, streamer_display_name: "Alpha", streamer_username: "alpha", platform: "twitch",
            timestamp: "2026-11-15T11:02:05Z", start_offset_sec: 3725, end_offset_sec: 3760, score: 77, confidence: 0.5, category: "unknown",
            reasons: ["Audio 12 dB louder than usual for 4 s"], origin: "vod", vod_url_at: "https://www.twitch.tv/videos/v1?t=1h2m5s",
            signal_breakdown: { chat: null, audio: 80, visual: 40, context: null }, status: "pending_review", clip: null }], total: 1, limit: 50, offset: 0 })
        : json({ detail: "Not Found" }, 404),
    );
    installWorker();
    window.location.hash = "/highlights";
    render(<App />);
    expect(await screen.findByText("from recording")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in VOD/ })).toHaveAttribute("href", "https://www.twitch.tv/videos/v1?t=1h2m5s");
    expect(screen.getByText(/signals: · audio 80 · visual 40/)).toBeInTheDocument();
  });

  it("exports and downloads the MP4", { timeout: 15000 }, async () => {
    let c: Record<string, unknown> = { id: 4, candidate_id: 1, platform: "kick", platform_clip_id: null, platform_clip_url: null, local_file_path: null,
      title: null, duration_seconds: 30, aspect_ratio: "9:16", status: "unsupported", error_message: null, source: "editor", edit_url: null,
      requested_at: null, request_lag_seconds: null, published_at: null, published_url: null, created_at: "2026-11-15T12:00:00Z" };
    let polls = 0;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    mockFetch((url, init) => {
      if (url.endsWith("/api/v1/clips/4/export") && init?.method === "POST") {
        c = { ...c, status: "exporting" };
        return json(c, 202);
      }
      if (url.endsWith("/api/v1/clips/4/file")) return new Response(new Blob(["mp4"]), { status: 200, headers: { "Content-Type": "video/mp4" } });
      if (url.includes("/api/v1/clips")) {
        // Stays "exporting" for a few refreshes, like a real FFmpeg job.
        if (c.status === "exporting" && ++polls >= 3) c = { ...c, status: "ready", local_file_path: "clip_4_9x16.mp4" };
        return json({ items: [c], total: 1, limit: 50, offset: 0 });
      }
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/clips";
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Export MP4" }));
    expect(await screen.findByText(/Exporting 9:16 MP4/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Download MP4" }, { timeout: 9000 }));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  });

  it("exports with burned-in subtitles and offers the .srt", { timeout: 15000 }, async () => {
    let c: Record<string, unknown> = { id: 5, candidate_id: 1, platform: "kick", platform_clip_id: null, platform_clip_url: null, local_file_path: null,
      subtitles_file_path: null, title: null, duration_seconds: 30, aspect_ratio: "9:16", status: "unsupported", error_message: null, source: "editor",
      edit_url: null, requested_at: null, request_lag_seconds: null, published_at: null, published_url: null, created_at: "2026-11-15T12:00:00Z" };
    const exportBodies: unknown[] = [];
    const downloads: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    mockFetch((url, init) => {
      if (url.endsWith("/api/v1/media/capabilities")) return json({ ffmpeg_available: true, max_upload_mb: 4096, media_folder: "/m", supported_extensions: [".mp4"], subtitles: "supported", live_tab_audio: "not_implemented" });
      if (url.endsWith("/api/v1/clips/5/export") && init?.method === "POST") {
        exportBodies.push(JSON.parse(String(init.body)));
        c = { ...c, status: "exporting" };
        return json(c, 202);
      }
      if (url.endsWith("/api/v1/clips/5/subtitles")) return new Response(new Blob(["1\n"]), { status: 200, headers: { "Content-Type": "application/x-subrip" } });
      if (url.includes("/api/v1/clips")) {
        if (c.status === "exporting") c = { ...c, status: "ready", local_file_path: "clip_5_9x16.mp4", subtitles_file_path: "clip_5_9x16.srt" };
        return json({ items: [c], total: 1, limit: 50, offset: 0 });
      }
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/clips";
    render(<App />);
    const toggle = await screen.findByRole("switch", { name: "Subtitles" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Export MP4" }));
    await waitFor(() => expect(exportBodies).toEqual([{ subtitles: true }]));
    await userEvent.click(await screen.findByRole("button", { name: "Download .srt" }, { timeout: 9000 }));
    await waitFor(() => expect(downloads).toContain("clip_5_9x16.srt"));
    // After a subtitled export the switch stays on for re-exports.
    expect(screen.getByRole("switch", { name: "Subtitles" })).toHaveAttribute("aria-checked", "true");
    clickSpy.mockRestore();
  });

  it("hides the subtitles switch when the backend can't transcribe", async () => {
    const c = { id: 6, candidate_id: 1, platform: "kick", platform_clip_id: null, platform_clip_url: null, local_file_path: null, subtitles_file_path: null,
      title: null, duration_seconds: 30, aspect_ratio: "9:16", status: "unsupported", error_message: null, source: "editor", edit_url: null,
      requested_at: null, request_lag_seconds: null, published_at: null, published_url: null, created_at: "2026-11-15T12:00:00Z" };
    mockFetch((url) => {
      if (url.endsWith("/api/v1/media/capabilities")) return json({ ffmpeg_available: true, max_upload_mb: 4096, media_folder: "/m", supported_extensions: [".mp4"], subtitles: "requires_configuration", live_tab_audio: "not_implemented" });
      if (url.includes("/api/v1/clips")) return json({ items: [c], total: 1, limit: 50, offset: 0 });
      return json({ detail: "Not Found" }, 404);
    });
    installWorker();
    window.location.hash = "/clips";
    render(<App />);
    expect(await screen.findByRole("button", { name: "Export MP4" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Subtitles" })).not.toBeInTheDocument();
  });
});
