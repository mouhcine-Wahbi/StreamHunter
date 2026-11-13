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
