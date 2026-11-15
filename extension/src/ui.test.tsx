import { render, screen, waitFor, within } from "@testing-library/react";
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
      url.endsWith("/heartbeat") ? json({ lease_expires_at: "2026-11-13T10:06:00Z" }) : json({ detail: "Not Found" }, 404),
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
