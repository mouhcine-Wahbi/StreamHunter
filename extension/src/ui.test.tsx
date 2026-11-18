import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/app/App";
import { Popup } from "@/popup/Popup";
import { SidePanel } from "@/sidepanel/SidePanel";
import { createMonitoringManager } from "@/background/monitoring-manager";
import { handleMessage } from "@/background/message-handler";
import { getSettings } from "@/store/storage";
import { json, mockFetch } from "@/test/http";
import { configurePlatforms, fakePlatforms } from "@/test/platforms";
import { getCredentials, setCredentials } from "@/platforms/credentials";
import { LocalApi } from "@/local/local-api";
import { db } from "@/local/db";
import { createHighlight, listHighlights } from "@/local/highlights";
import { listClips, saveClip } from "@/local/clips";
import { ACTIVITY_KEY, KICK_CHAT_REASON } from "@/background/chat-manager";
import { CAPTURES_KEY, INITIAL_CAPTURE_STATE } from "@/types/capture";
import type { Streamer } from "@/types/api";

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
    await configurePlatforms();
    fakePlatforms({});
    installWorker();
    render(<Popup />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /start monitoring/i }));
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /stop monitoring/i })).toBeInTheDocument();
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

describe("popup capture (capture mode)", () => {
  function workerWithCapture(onStart: (msg: { tabId: number; url: string }) => void) {
    chrome.runtime.onMessage.addListener((msg: unknown, _sender, respond) => {
      const m = msg as { type: string; tabId: number; url: string; seconds?: number };
      const capturing = { ...INITIAL_CAPTURE_STATE, status: "capturing", recording: true, tabId: 42, platform: "twitch", channel: "streamerone", streamerId: 1,
        startedAt: "2026-11-17T12:00:00Z", bufferedSeconds: 45, levelDb: -21, message: "Buffering the last 2 minutes. Detected moments become clips." };
      if (m.type === "capture/start" || m.type === "capture/arm") {
        onStart(m);
        void chrome.storage.local.set({ [CAPTURES_KEY]: { slots: { 42: capturing } } }).then(() => respond({ ok: true, data: capturing }));
        return true;
      }
      if (m.type === "capture/save-last") {
        const s = { ...capturing, message: `Saving the last ${m.seconds} s…` };
        void chrome.storage.local.set({ [CAPTURES_KEY]: { slots: { 42: s } } }).then(() => respond({ ok: true, data: s }));
        return true;
      }
      if (m.type === "capture/stop") {
        const s = { ...INITIAL_CAPTURE_STATE, clips: 2 };
        void chrome.storage.local.set({ [CAPTURES_KEY]: { slots: {}, clips: 2 } }).then(() => respond({ ok: true, data: s }));
        return true;
      }
      return false;
    });
  }

  it("captures a Twitch channel tab, saves the last 30 s and stops", async () => {
    mockFetch(() => null);
    fakeChrome.internals.setActiveTab({ id: 42, url: "https://www.twitch.tv/StreamerOne" });
    const starts: unknown[] = [];
    workerWithCapture((m) => starts.push(m));
    render(<Popup />);
    await userEvent.click(await screen.findByRole("button", { name: "Only capture this stream (streamerone)" }));
    expect(starts).toEqual([{ type: "capture/start", tabId: 42, url: "https://www.twitch.tv/StreamerOne" }]);
    expect(await screen.findByText("Recording")).toBeInTheDocument();
    expect(screen.getByText(/45 s buffered/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save last 30 s" }));
    expect(await screen.findByText("Saving the last 30 s…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop capture" }));
    expect(await screen.findByRole("button", { name: "Only capture this stream (streamerone)" })).toBeInTheDocument();
  });

  it("arms any Twitch/Kick tab as the automatic recorder", async () => {
    mockFetch(() => null);
    fakeChrome.internals.setActiveTab({ id: 42, url: "https://www.twitch.tv/directory" });
    const starts: unknown[] = [];
    workerWithCapture((m) => starts.push(m));
    render(<Popup />);
    await userEvent.click(await screen.findByRole("button", { name: "Use this tab as a recorder" }));
    expect(starts).toEqual([{ type: "capture/arm", tabId: 42 }]);
    expect(screen.queryByRole("button", { name: /Only capture this stream/ })).not.toBeInTheDocument(); // a directory page is not a channel
  });

  it("explains what to do on other pages", async () => {
    mockFetch(() => null);
    fakeChrome.internals.setActiveTab({ id: 1, url: "https://example.com/" });
    render(<Popup />);
    expect(await screen.findByText(/Open twitch.tv or kick.com in this tab to record from it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /recorder|capture this stream/i })).not.toBeInTheDocument();
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
      ["Highlights", "Top Highlights"],
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
  it("shows real search results from Kick, with live discovery before searching", async () => {
    await configurePlatforms();
    fakePlatforms({
      kick: [{ id: "42", login: "somechannel", live: true, viewers: 1234, title: "Late night", game: "Just Chatting" }],
      twitch: [{ id: "1", login: "toplive", name: "TopLive", live: true, viewers: 50_000, game: "Chess" }],
    });
    installWorker();
    window.location.hash = "/discover";
    render(<App />);
    expect(await screen.findByText("TopLive")).toBeInTheDocument(); // live now on Twitch
    expect(screen.getByText(/50,000 viewers/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("radio", { name: "Kick" }));
    await userEvent.type(screen.getByLabelText("Channel name"), "somechannel");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("somechannel")).toBeInTheDocument();
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByText(/Just Chatting · 1,234 viewers/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open somechannel's stream" }));
    expect(fakeChrome.internals.createdTabs).toEqual(["https://kick.com/somechannel"]);
  });
  it("treats 'already on the list' as added and shows platform-not-configured clearly", async () => {
    await setCredentials("twitch", { clientId: "tw-client", clientSecret: "tw-secret" });
    fakePlatforms({ twitch: [{ id: "1", login: "alpha", name: "Alpha" }] });
    await new LocalApi().post("/api/v1/streamers", { platform: "twitch", username: "alpha" });
    installWorker();
    window.location.hash = "/discover";
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Channel name"), "alpha");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByRole("button", { name: "Monitoring" })).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: "Kick" }));
    await userEvent.type(screen.getByLabelText("Channel name"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Not available yet")).toBeInTheDocument();
    expect(screen.getByText(/Add your Kick app's client ID and secret in Settings/)).toBeInTheDocument();
  });
});

describe("side panel", () => {
  it("renders the highlight feed state", async () => {
    mockFetch(() => null);
    installWorker();
    render(<SidePanel />);
    expect(await screen.findByText("Nothing to review yet")).toBeInTheDocument();
  });
});

describe("platforms & status (local-first)", () => {
  it("saves the editor's own app credentials, tests them, and never shows the secret again", async () => {
    fakePlatforms({ twitch: [{ id: "1", login: "toplive", live: true }] });
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    expect(await screen.findAllByText("not configured")).toHaveLength(2);
    await userEvent.type(screen.getByLabelText("twitch client ID"), "my-id");
    await userEvent.type(screen.getByLabelText("twitch client secret"), "my-secret");
    await userEvent.click(screen.getAllByRole("button", { name: "Save and test" })[0]!);
    expect(await screen.findByText(/Saved and working: Twitch answered/)).toBeInTheDocument();
    expect(await getCredentials()).toMatchObject({ twitch: { clientId: "my-id", clientSecret: "my-secret" } });
    expect(screen.getByLabelText("twitch client secret")).toHaveValue("");
    expect(await screen.findByText("app credentials saved")).toBeInTheDocument();
  });

  it("says when the platform rejects the credentials", async () => {
    const { fetch } = fakePlatforms({});
    fetch.mockImplementation(async () => json({ status: 403, message: "invalid client secret" }, 403));
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    await userEvent.type(await screen.findByLabelText("kick client ID"), "id");
    await userEvent.type(screen.getByLabelText("kick client secret"), "wrong");
    await userEvent.click(screen.getAllByRole("button", { name: "Save and test" })[1]!);
    expect(await screen.findByText(/Kick rejected the client ID or secret/)).toBeInTheDocument();
  });

  it("refreshes the monitoring list and reports platform problems", async () => {
    await setCredentials("twitch", { clientId: "tw-client", clientSecret: "tw-secret" });
    fakePlatforms({ twitch: [{ id: "1", login: "alpha", live: true, viewers: 10 }] });
    await new LocalApi().post("/api/v1/streamers", { platform: "twitch", username: "alpha" });
    await db.put<Partial<Streamer>>("streamers", { platform: "kick", platform_user_id: "9", username: "kk", display_name: "kk", profile_image_url: null, is_live: null,
      current_title: null, current_category: null, viewer_count: null, stream_started_at: null, status_checked_at: null, monitoring_enabled: true,
      is_favorite: false, updated_at: "2026-11-17T00:00:00Z" });
    installWorker();
    window.location.hash = "/streamers";
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText(/Checked 1, 1 live\. kick: Add your Kick app's client ID/)).toBeInTheDocument();
  });
});

const T = Date.parse("2026-11-17T12:00:00Z");

async function seedSession(status: "active" | "ended" = "active") {
  await db.put<Partial<Streamer>>("streamers", { id: 1, platform: "twitch", platform_user_id: "101", username: "alpha", display_name: "Alpha",
    is_live: true, monitoring_enabled: true, is_favorite: false, profile_image_url: null, current_title: null, current_category: null,
    viewer_count: 10, stream_started_at: "2026-11-17T11:30:00Z", status_checked_at: null, updated_at: "2026-11-17T11:30:00Z" });
  await db.put("sessions", { id: 1, streamer_id: 1, streamer_display_name: "Alpha", platform: "twitch", broadcast_started_at: "2026-11-17T11:30:00Z",
    started_at: "2026-11-17T11:30:00Z", ended_at: null, status, last_checked_at: null, last_event_at: null, error_message: null });
}

async function seedHighlight(score = 84, reasons = ["'KEKW' used by 40 chatters (85% of chat)", "Chat activity 4.2× its normal level (52 chatters in 15 s)"]) {
  return createHighlight({
    streamer: { id: 1, display_name: "Alpha", username: "alpha", platform: "twitch" },
    session: { id: 1, broadcast_started_at: "2026-11-17T11:30:00Z" },
    origin: "chat", peakAt: T, startAt: T - 20_000, endAt: T + 10_000, score, confidence: 0.93, category: "funny_moment", reasons,
    breakdown: { chat: score, audio: null, visual: null, context: null, active_signals: ["chat"] },
  });
}

describe("monitoring, highlights and clips (local data)", () => {
  it("shows chat state, activity and unavailable reasons per active session", async () => {
    await seedSession();
    await db.put("streamers", { id: 2, platform: "kick", platform_user_id: "7", username: "kk", display_name: "Kickstar", monitoring_enabled: true } as never);
    await db.put("sessions", { id: 2, streamer_id: 2, streamer_display_name: "Kickstar", platform: "kick", broadcast_started_at: null,
      started_at: "2026-11-17T11:30:00Z", ended_at: null, status: "active", last_checked_at: null, last_event_at: null, error_message: null });
    await chrome.storage.local.set({ [ACTIVITY_KEY]: {
      1: { chat_state: "connected", chat_reason: null, messages_per_minute: 42, unique_chatters_per_minute: 17, baseline_messages_per_minute: 20.5, warming_up: false, series: [1, 2, 3], active_signals: ["chat_spike"] },
      2: { chat_state: "unavailable", chat_reason: KICK_CHAT_REASON },
    } });
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/monitoring";
    render(<App />);
    expect(await screen.findByText("Chat connected")).toBeInTheDocument();
    expect(screen.getByText(/42\/min · 17 chatters · normal 20.5\/min/)).toBeInTheDocument();
    expect(screen.getByText("chat spike")).toBeInTheDocument();
    expect(await screen.findByText("Chat unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Kick delivers chat only to servers/)).toBeInTheDocument();
  });

  it("explains a provisional highlight and lets the editor approve, reject and reopen it", async () => {
    await seedSession();
    await seedHighlight();
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/highlights";
    render(<App />);
    expect(await screen.findByText("No clips yet")).toBeInTheDocument(); // a provisional moment is never shown as a clip
    await userEvent.click(screen.getByRole("button", { name: /Show/ }));
    expect(await screen.findByText("'KEKW' used by 40 chatters (85% of chat)")).toBeInTheDocument();
    expect(screen.getByText("provisional · no video")).toBeInTheDocument();
    expect(screen.getByText("from chat")).toBeInTheDocument();
    expect(screen.getByText(/Confidence 93% · signals: chat 84 · capture the stream to get video/)).toBeInTheDocument();
    expect(screen.getByText(/≈0:29:40 into stream/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open stream/ })).toHaveAttribute("href", "https://www.twitch.tv/alpha");

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument());
    expect((await listHighlights())[0]!.status).toBe("approved");
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect((await listHighlights())[0]!.status).toBe("pending_review");
  });

  it("Top Highlights ranks clips by score and filters them by detection type, platform and duration", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => undefined }));
    await seedSession();
    const low = await seedHighlight(70, ["lower"]);
    const top = await seedHighlight(95, ["higher"]);
    const base = { sessionId: 1, streamerId: 1, streamerName: "Alpha", platform: "twitch" as const, startedAt: T - 20_000, width: 1280, height: 720, blob: new Blob(["mp4"], { type: "video/mp4" }), category: "Chess" };
    await saveClip({ ...base, candidateId: low.id, title: "Alpha · lower", durationSec: 70, score: 55, reasons: ["Fast on-screen action"], detectionTypes: ["visual", "viewers"] });
    await saveClip({ ...base, candidateId: top.id, title: "Alpha · higher", durationSec: 40, score: 88, reasons: ["Laughter-like rhythmic bursts", "Chat is laughing"], detectionTypes: ["audio", "chat"] });
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/highlights";
    render(<App />);
    const titles = await screen.findAllByText(/^Alpha · (higher|lower)$/);
    expect(titles.map((r) => r.textContent)).toEqual(["Alpha · higher", "Alpha · lower"]);
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("· Laughter-like rhythmic bursts")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Detection type"), "visual");
    await waitFor(() => expect(screen.queryByText("Alpha · higher")).not.toBeInTheDocument());
    expect(screen.getByText("Alpha · lower")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Duration"), "short");
    expect(await screen.findByText("No clips match these filters")).toBeInTheDocument();
  });

  it("clip library: preview, download as MP4, rename and delete with confirmation", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:clip-1", revokeObjectURL: () => undefined }));
    await seedSession();
    const h = await seedHighlight();
    await saveClip({ candidateId: h.id, sessionId: 1, streamerId: 1, streamerName: "Alpha", platform: "twitch", title: "Alpha · KEKW wave",
      startedAt: T - 20_000, durationSec: 31.5, width: 1280, height: 720, score: 84, blob: new Blob(["x".repeat(2_097_152)], { type: "video/mp4" }) });
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/clips";
    render(<App />);
    expect(await screen.findByText("Alpha · KEKW wave")).toBeInTheDocument();
    expect(screen.getByText("31.5 s")).toBeInTheDocument();
    expect(screen.getByText("1280×720 · 2.0 MB")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mark as favourite" }));
    expect(await screen.findByRole("button", { name: "Remove from favourites" })).toBeInTheDocument();
    expect((await listClips())[0]!.favorite).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Preview Alpha · KEKW wave" }));
    expect(screen.getByLabelText("Preview of Alpha · KEKW wave")).toHaveAttribute("src", "blob:clip-1");
    const download = await screen.findByRole("link", { name: /Download MP4/ });
    expect(download).toHaveAttribute("href", "blob:clip-1");
    expect(download.getAttribute("download")).toMatch(/^Alpha_2026-11-17-11-59-40_1\.mp4$/);

    await userEvent.click(screen.getByRole("button", { name: "Rename clip" }));
    const title = screen.getByLabelText("Clip title");
    await userEvent.clear(title);
    await userEvent.type(title, "Best laugh{Enter}");
    expect(await screen.findByText("Best laugh")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete clip" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(await screen.findByText("No clips yet")).toBeInTheDocument();
    expect(await db.get("clipBlobs", 1)).toBeUndefined();
  });
});
