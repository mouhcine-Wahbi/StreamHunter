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
import { createProcessingManager } from "@/background/processing-manager";
import { listAssets, patchAsset, queueAssets } from "@/local/assets";
import { prepareContent, type ContentClip } from "@/local/content";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { COMPANION_KEY, type CompanionManager, type CompanionStatus } from "@/companion/client";

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
    await userEvent.click(await screen.findByRole("button", { name: "Use this tab as a recorder (1 of 3)" }));
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
      ["Find Creators", "Find Creators"],
      ["My Creators", "My Creators"],
      ["Live Monitoring", "Live Monitoring"],
      ["Content Discovery", "Content Discovery"],
      ["Clip Queue", "Clip Queue"],
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
  it("3.0: content discovery keywords, filters and vertical layout are saved", async () => {
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    await userEvent.type(screen.getByLabelText("Keywords"), "speedrun{Enter}");
    const minViews = screen.getByLabelText("Minimum views");
    await userEvent.clear(minViews);
    await userEvent.type(minViews, "5000{Enter}");
    await userEvent.click(screen.getByRole("checkbox", { name: "Comedy" }));
    await userEvent.selectOptions(screen.getByLabelText("Default vertical layout"), "center");
    await waitFor(async () => {
      const s = await getSettings();
      expect(s.discovery.keywords).toEqual(["speedrun"]);
      expect(s.discovery.minViews).toBe(5000);
      expect(s.discovery.youtubeCategories).toEqual(["20", "23"]);
      expect(s.formats.verticalLayout).toBe("center");
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
    expect(await screen.findAllByText("not configured")).toHaveLength(3);
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
    expect(screen.getByText(/Original · 1280×720 · 31.5 s · 2.0 MB/)).toBeInTheDocument();
    const card = screen.getByRole("article", { name: "Clip: Alpha · KEKW wave" });
    expect(within(card).getByText("Alpha")).toBeInTheDocument();
    expect(within(card).getByRole("status", { name: "Status: Ready" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mark as favourite" }));
    expect(await screen.findByRole("button", { name: "Remove from favourites" })).toBeInTheDocument();
    expect((await listClips())[0]!.favorite).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Preview of Alpha · KEKW wave (original)")).toHaveAttribute("src", "blob:clip-1"));
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    await userEvent.click(screen.getByRole("button", { name: "Download Original MP4" }));
    await waitFor(() => expect(saved).toEqual(["Alpha_2026-11-17-11-59-40_1.mp4"]));

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

describe("2.0 dashboard: scheduler, streamers, score explanations, health", () => {
  it("Live Monitoring shows slots, who records, the queue with reasons and explained priorities", async () => {
    mockFetch(() => null);
    installWorker();
    await chrome.storage.local.set({
      [CAPTURES_KEY]: { slots: { 5: { ...INITIAL_CAPTURE_STATE, status: "capturing", mode: "recorder", recording: true, tabId: 5, streamerId: 1, channel: "alpha", platform: "twitch", armedAt: "a", assignedAt: new Date(Date.now() - 12 * 60_000).toISOString() } } },
      "sh.scheduler": {
        at: new Date().toISOString(), maxSlots: 3, armedSlots: 1, tracked: 3, live: 3, lastRecordingAt: new Date().toISOString(), failures: [{ streamerId: 3, name: "Charlie", error: "the player shows a black screen", failures: 1, retryAt: new Date(Date.now() + 120_000).toISOString() }],
        recording: [], decisions: [],
        queue: [
          { streamerId: 2, name: "Bravo", total: 61, reason: "waiting_for_slot", detail: "Waiting for a slot." },
          { streamerId: 3, name: "Charlie", total: 40, reason: "retry_wait", detail: "Recording failed (the player shows a black screen); retrying 12:02." },
        ],
        priorities: [{ streamerId: 1, name: "Alpha", platform: "twitch", username: "alpha", platformUserId: "1", total: 72, parts: {}, explain: ["Highlight potential 88: 6.0 clips per recorded hour here, average score 70."] }],
      },
    });
    window.location.hash = "/monitoring";
    render(<App />);
    expect(await screen.findByText("1 recording / 3")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 slots have no recorder tab/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open 2 recorder tabs" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for a slot.")).toBeInTheDocument();
    expect(screen.getByText("Retrying later")).toBeInTheDocument();
    expect(screen.getByText(/Charlie: the player shows a black screen \(1×, retry/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Alpha\s*72/ }));
    expect(screen.getByText(/Highlight potential 88: 6.0 clips per recorded hour here/)).toBeInTheDocument();
  });

  it("My Streamers: add by link (platform read from the link), set priority, favourite", async () => {
    await configurePlatforms();
    fakePlatforms({ kick: [{ id: "77", login: "kickstar", live: true, viewers: 900 }] });
    installWorker();
    window.location.hash = "/streamers";
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Channel name or link"), "https://kick.com/kickstar");
    expect(screen.getByLabelText("Platform")).toHaveValue("kick");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Added kickstar (Kick).")).toBeInTheDocument();
    expect(await screen.findByText("0 clips")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Priority for kickstar"), "2");
    await waitFor(async () => expect((await db.all<Streamer>("streamers"))[0]).toMatchObject({ priority: 2, auto_record: true }));
    await userEvent.click(screen.getByRole("button", { name: "Mark kickstar as favourite" }));
    await waitFor(async () => expect((await db.all<Streamer>("streamers"))[0]!.is_favorite).toBe(true));
  });

  it("Top Highlights explains a clip's score and lists failed clips separately", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => undefined }));
    await seedSession();
    const h = await seedHighlight(80, ["Laughter-like rhythmic bursts"]);
    await saveClip({ candidateId: h.id, sessionId: 1, streamerId: 1, streamerName: "Alpha", platform: "twitch", title: "Alpha · laugh", startedAt: T, durationSec: 45, width: 1280, height: 720, score: 51,
      blob: new Blob(["mp4"], { type: "video/mp4" }), detectionTypes: ["audio", "chat"], explain: { parts: { audio: 20, chat: 21, visual: 0, viewers: 0, multi: 10 }, confidence: 0.7, eventSeconds: 6 } });
    const failed = await createHighlight({ streamer: { id: 1, display_name: "Alpha", username: "alpha", platform: "twitch" }, session: null, origin: "capture", peakAt: T, startAt: T, endAt: T, score: 48, confidence: 0.7, category: "x", reasons: ["Loud"], breakdown: {}, clipStatus: "generating" });
    const { markClipFailed } = await import("@/local/highlights");
    await markClipFailed(failed.id, "Browser storage is full: delete clips or lower the storage limit in Settings.");
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/highlights";
    render(<App />);
    expect(await screen.findByText("In progress and failed")).toBeInTheDocument();
    expect(screen.getByText("Browser storage is full: delete clips or lower the storage limit in Settings.")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Why this score?" }));
    const why = screen.getByLabelText("Why this score");
    expect(within(why).getByText("+20")).toBeInTheDocument();
    expect(within(why).getByText("+21")).toBeInTheDocument();
    expect(within(why).getByText("+10")).toBeInTheDocument();
    expect(within(why).getByText(/Confidence 70% \(2 independent signals\) · event lasted 6 s/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Platform"), "youtube");
    expect(await screen.findByText("No clips match these filters")).toBeInTheDocument();
  });

  it("System Health shows only measured values and per-platform connectivity", async () => {
    await configurePlatforms();
    mockFetch(() => null);
    installWorker();
    await chrome.storage.local.set({
      "sh.monitoring": { enabled: true, paused: false, status: "degraded", platformErrors: { kick: "Kick asked StreamHunter to slow down." }, lastSuccessAt: new Date().toISOString() },
    });
    window.location.hash = "/health";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "System Health" })).toBeInTheDocument();
    expect(screen.getByText("Measured once a recording runs.")).toBeInTheDocument(); // no fabricated CPU numbers
    expect(await screen.findByText("Kick asked StreamHunter to slow down.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply storage limits now" })).toBeInTheDocument();
    expect(await screen.findByText(/No clip was lost to a restart/)).toBeInTheDocument(); // loaded from IndexedDB
  });
});

describe("3.0 recording approvals in the dashboard", () => {
  it("lists pending requests with Record / Decline / Remind me later, and Record sends your decision", async () => {
    mockFetch(() => null);
    const decisions: unknown[] = [];
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const m = message as { type?: string; id?: string; action?: string };
      if (m.type !== "approval/decide") return false;
      decisions.push(m);
      sendResponse({ ok: true, data: null });
      return true;
    });
    const base = { platform: "twitch", username: "alpha", title: "Ranked grind", category: "Valorant", viewers: 1200, createdAt: new Date().toISOString(), decidedAt: null, remindAt: null, notifications: 1, endedAt: null, note: null };
    await chrome.storage.local.set({
      "sh.approvals": {
        items: [
          { ...base, id: "1|twitch:b1", streamerId: 1, streamerName: "Alpha", broadcastId: "twitch:b1", status: "pending" },
          { ...base, id: "2|twitch:b2", streamerId: 2, streamerName: "Bravo", broadcastId: "twitch:b2", status: "approved" },
          { ...base, id: "3|twitch:b0", streamerId: 3, streamerName: "Charlie", broadcastId: "twitch:b0", status: "expired", endedAt: new Date().toISOString(), note: "Not answered. The broadcast ended." },
        ],
      },
      "sh.scheduler": { at: new Date().toISOString(), maxSlots: 3, armedSlots: 3, tracked: 3, live: 2, lastRecordingAt: null, failures: [], recording: [], decisions: [], priorities: [],
        queue: [{ streamerId: 2, name: "Bravo", total: 60, reason: "waiting_for_slot", detail: "Approved, #1 in the queue: all 3 slots busy." }] },
    });
    window.location.hash = "/monitoring";
    render(<App />);
    const pending = await screen.findByRole("region", { name: "Pending approvals" });
    expect(within(pending).getByText("Alpha")).toBeInTheDocument();
    expect(within(pending).getByText("Valorant · Ranked grind")).toBeInTheDocument();
    expect(within(pending).getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(within(pending).getByRole("button", { name: "Remind me in 10 min" })).toBeInTheDocument();
    const approved = screen.getByRole("region", { name: "Approved streams" });
    expect(within(approved).getAllByText("Approved, #1 in the queue: all 3 slots busy.").length).toBeGreaterThan(0);
    expect(within(approved).getByRole("button", { name: "Stop recording this stream" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Approval history" })).getByText("Not answered. The broadcast ended.")).toBeInTheDocument();
    await userEvent.click(within(pending).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(decisions).toEqual([{ type: "approval/decide", id: "1|twitch:b1", action: "approve" }]));
  });
});

describe("3.0 output formats in the dashboard", () => {
  it("Short-form Clips shows each clip's vertical version with the layout and why, and remakes it with a per-clip layout", async () => {
    mockFetch(() => null);
    const kicks: unknown[] = [];
    const manager = createMonitoringManager();
    const processing = createProcessingManager({ ensureOffscreen: async () => undefined, kick: async () => void kicks.push(1), closeIfIdle: async () => undefined });
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      handleMessage(msg, manager, undefined, undefined, undefined, processing).then(respond);
      return true;
    });
    const c = await saveClip({ candidateId: 0, sessionId: null, streamerId: 0, streamerName: "StreamerOne", platform: "twitch", title: "Big clutch", startedAt: Date.now(), durationSec: 30, width: 1920, height: 1080, score: 80, blob: new Blob([new Uint8Array(4)], { type: "video/mp4" }) });
    const [a] = await queueAssets(c.id, ["vertical"], { layout: { kind: "facecam_top", facecam: null }, source: "default" });
    await patchAsset(a!.id, { status: "ready", used_layout: "center", width: 1080, height: 1920, duration_seconds: 30, size_bytes: 5 * 1024 ** 2, notes: ["No facecam position is set for this creator, so the centre crop was used."] });
    window.location.hash = "/shorts";
    render(<App />);
    expect(await screen.findByText("Big clutch")).toBeInTheDocument();
    expect(screen.getByText(/1080×1920 · 30 s · 5.0 MB · Centre crop \(default from Settings\)/)).toBeInTheDocument();
    expect(screen.getByText("No facecam position is set for this creator, so the centre crop was used.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Layout for Big clutch"), "action");
    await userEvent.click(screen.getByRole("button", { name: "Remake" }));
    await waitFor(async () => expect((await listAssets(c.id))[0]).toMatchObject({ status: "queued", layout: { kind: "action" }, layout_source: "clip" }));
    expect(kicks.length).toBe(1);
    expect(await screen.findByText("Waiting")).toBeInTheDocument();
  });

  it("X Clips shows the score with its reasons and saves your own post text (credit kept)", async () => {
    mockFetch(() => null);
    installWorker();
    const c = await saveClip({ candidateId: 0, sessionId: null, streamerId: 0, streamerName: "StreamerOne", platform: "twitch", title: "Big clutch", startedAt: Date.now(), durationSec: 30, width: 1920, height: 1080, score: 80, blob: new Blob([new Uint8Array(4)], { type: "video/mp4" }), reasons: ["Loud laughter"] });
    const s = structuredClone(DEFAULT_SETTINGS);
    s.ai.onDevice = false;
    await prepareContent(c.id, s);
    window.location.hash = "/xclips";
    render(<App />);
    expect(await screen.findByText("Big clutch")).toBeInTheDocument();
    expect(screen.getByText(/Low potential|Medium potential|High potential/)).toBeInTheDocument();
    expect(screen.getByText(/not a prediction of views/)).toBeInTheDocument();
    expect(screen.getByText(/No live audience data/)).toBeInTheDocument();
    expect(screen.getByText(/· Local templates/)).toBeInTheDocument();
    const post = screen.getByLabelText(/^Post \(/);
    await userEvent.clear(post);
    await userEvent.type(post, "What a clutch");
    await userEvent.click(screen.getByRole("button", { name: "Save X text" }));
    await waitFor(async () => {
      const row = await db.get<ContentClip>("clips", c.id);
      expect(row!.metadata!.edited).toEqual(["x"]);
      expect(row!.metadata!.byDestination.x.description).toMatch(/^What a clutch\n\nCredit: StreamerOne on Twitch/);
    });
  });

  it("Clip Library: versions with their own downloads, status, recommendation, copyable text per platform and filters", async () => {
    mockFetch(() => null);
    installWorker();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    const blob = () => new Blob([new Uint8Array(4)], { type: "video/mp4" });
    const a = await saveClip({ candidateId: 0, sessionId: null, streamerId: 0, streamerName: "StreamerOne", platform: "twitch", title: "Big clutch", startedAt: Date.parse("2026-11-10T12:00:00Z"), durationSec: 30, width: 1920, height: 1080, score: 80, blob: blob(), reasons: ["Loud laughter"] });
    const [v, l] = await queueAssets(a.id, ["vertical", "landscape"], { layout: { kind: "center", facecam: null }, source: "default" });
    await patchAsset(v!.id, { status: "ready", used_layout: "center", width: 1080, height: 1920, duration_seconds: 30, size_bytes: 1024 });
    await patchAsset(l!.id, { status: "ready", used_layout: "landscape", width: 1920, height: 1080, duration_seconds: 30, reused_original: true });
    await db.putBlob(v!.id, blob(), "assetBlobs");
    const s = structuredClone(DEFAULT_SETTINGS);
    s.ai.onDevice = false;
    const prepared = await prepareContent(a.id, s);
    const b = await saveClip({ candidateId: 0, sessionId: null, streamerId: 0, streamerName: "Bravo", platform: "kick", title: "Bravo moment", startedAt: Date.parse("2026-11-20T12:00:00Z"), durationSec: 20, width: 1280, height: 720, score: 40, blob: blob() });
    await queueAssets(b.id, ["vertical"], { layout: null, source: "default" });
    const c = await saveClip({ candidateId: 0, sessionId: null, streamerId: 0, streamerName: "Charlie", platform: "twitch", title: "Charlie moment", startedAt: Date.parse("2026-11-21T12:00:00Z"), durationSec: 20, width: 1280, height: 720, score: 50, blob: blob() });
    const [cv] = await queueAssets(c.id, ["vertical"], { layout: null, source: "default" });
    await patchAsset(cv!.id, { status: "failed", error: "The video couldn't be decoded." });

    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void (copied = t) } });
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    window.location.hash = "/clips";
    render(<App />);
    const card = await screen.findByRole("article", { name: "Clip: Big clutch" });
    expect(within(card).getByRole("status", { name: "Status: Ready" })).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Clip: Bravo moment" })).getByRole("status", { name: "Status: Generating" })).toBeInTheDocument();
    const failed = screen.getByRole("article", { name: "Clip: Charlie moment" });
    expect(within(failed).getByRole("status", { name: "Status: Failed" })).toBeInTheDocument();
    expect(within(failed).getByText(/Vertical 9:16 version failed: The video couldn't be decoded\./)).toBeInTheDocument();
    // Detection time, source link, score explanation and recommendation.
    expect(within(card).getByText("Detected")).toBeInTheDocument();
    expect(within(card).getByText(/High potential|Medium potential|Low potential/)).toBeInTheDocument();
    expect(within(card).getByText(prepared.viral!.summary)).toBeInTheDocument();
    expect(within(card).getByLabelText("Platform recommendation").textContent).toMatch(/YouTube Shorts|TikTok|X/);
    expect(within(card).getByText(/same file as the original/)).toBeInTheDocument();
    // One download per version.
    await userEvent.click(within(card).getByRole("button", { name: "Download Vertical 9:16 MP4" }));
    await userEvent.click(within(card).getByRole("button", { name: "Download Landscape MP4" }));
    await userEvent.click(within(card).getByRole("button", { name: "Download Original MP4" }));
    await waitFor(() => expect(saved).toEqual([`StreamerOne_2026-11-10-12-00-00_${a.id}-vertical.mp4`, `StreamerOne_2026-11-10-12-00-00_${a.id}-landscape.mp4`, `StreamerOne_2026-11-10-12-00-00_${a.id}.mp4`]));
    expect(within(failed).queryByRole("button", { name: "Download Vertical 9:16 MP4" })).toBeNull();
    // Copy buttons, per platform.
    const yt = prepared.metadata!.byDestination.youtube;
    await userEvent.click(within(card).getByRole("button", { name: "Copy title (YouTube Shorts)" }));
    expect(copied).toBe(yt.title);
    await userEvent.click(within(card).getByRole("button", { name: "Copy hashtags (YouTube Shorts)" }));
    expect(copied).toBe(yt.hashtags.join(" "));
    await userEvent.click(within(card).getByRole("tab", { name: "X" }));
    const x = prepared.metadata!.byDestination.x;
    expect(within(card).queryByRole("button", { name: /Copy title/ })).toBeNull(); // X has no title field
    await userEvent.click(within(card).getByRole("button", { name: "Copy description (X)" }));
    expect(copied).toBe(x.description);
    await userEvent.click(within(card).getByRole("button", { name: "Copy all (X)" }));
    expect(copied).toContain(x.description);
    expect(within(card).getByText(/Credit: StreamerOne on Twitch/)).toBeInTheDocument();
    // Filters: creator, format, score, date, status.
    await userEvent.selectOptions(screen.getByLabelText("Creator"), "Bravo");
    expect(screen.getByText("1 of 3 clips match the filters")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Clip: Big clutch" })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Creator"), "");
    await userEvent.selectOptions(screen.getByLabelText("Format"), "vertical");
    expect(screen.getAllByRole("article").map((e) => e.getAttribute("aria-label"))).toEqual(["Clip: Big clutch"]);
    await userEvent.selectOptions(screen.getByLabelText("Format"), "all");
    await userEvent.type(screen.getByLabelText("Minimum score"), "45");
    expect(screen.queryByRole("article", { name: "Clip: Bravo moment" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await userEvent.type(screen.getByLabelText("Detected from"), "2026-11-15");
    expect(screen.queryByRole("article", { name: "Clip: Big clutch" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await userEvent.selectOptions(screen.getByLabelText("Status"), "failed");
    expect(screen.getAllByRole("article").map((e) => e.getAttribute("aria-label"))).toEqual(["Clip: Charlie moment"]);
  });

  it("Settings → Companion: setup steps with this extension's ID, Allow asks Chrome, then shows the tools; Health shows the state", async () => {
    mockFetch(() => null);
    const manager = createMonitoringManager();
    const connected: CompanionStatus = {
      state: "connected", message: null, version: "0.1.0", protocol: 1, node: "v22.23.5", work_dir: "/Users/me/Library/Application Support/StreamHunter", free_bytes: 300 * 1024 ** 3, used_bytes: 5 * 1024 ** 2, checked_at: new Date().toISOString(),
      tools: {
        ffmpeg: { name: "ffmpeg", found: true, path: "/opt/homebrew/bin/ffmpeg", version: "9.0.2", ok: true, detail: null, min: "6.0", why: "cutting and encoding", videotoolbox: true },
        "yt-dlp": { name: "yt-dlp", found: true, path: "/opt/homebrew/bin/yt-dlp", version: "2025.01.01", ok: false, detail: "Version 2025.01.01 is older than 2025.11.12", min: "2025.11.12", why: "YouTube" },
      },
    };
    const companion = { check: vi.fn(async () => (await chrome.storage.local.set({ [COMPANION_KEY]: connected }), connected)), endpoint: vi.fn(), request: vi.fn(), close: vi.fn(), connected: true } as unknown as CompanionManager;
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      handleMessage(msg, manager, undefined, undefined, undefined, undefined, undefined, companion).then(respond);
      return true;
    });
    const request = vi.spyOn(chrome.permissions, "request").mockImplementation((async () => true) as never);
    window.location.hash = "/settings";
    const { unmount } = render(<App />);
    expect(await screen.findByRole("status", { name: "Companion: Not checked yet" })).toBeInTheDocument();
    expect(screen.getByLabelText("Install command")).toHaveTextContent(`node install.mjs --extension-id ${chrome.runtime.id}`);
    await userEvent.click(screen.getByRole("button", { name: "Allow and connect" }));
    expect(request).toHaveBeenCalledWith({ permissions: ["nativeMessaging"] });
    expect(await screen.findByRole("status", { name: "Companion: Connected" })).toBeInTheDocument();
    const tools = screen.getByRole("table", { name: "Companion tools" });
    expect(within(tools).getByText("hardware encoding (VideoToolbox)")).toBeInTheDocument();
    expect(within(tools).getByText(/older than 2025\.11\.12 · needs 2025\.11\.12/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Install command")).toBeNull();
    unmount();
    window.location.hash = "/health";
    render(<App />);
    expect(await screen.findByLabelText("Companion tools ready")).toHaveTextContent("1 of 2 tools ready: missing or too old: yt-dlp");
  });

  it("works with no social accounts: no publishing screens, settings or connect buttons anywhere", async () => {
    mockFetch(() => null);
    installWorker();
    window.location.hash = "/settings";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Titles, descriptions and hashtags" })).toBeInTheDocument();
    expect(screen.queryByText(/Publishing Studio|Performance/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect account/ })).toBeNull();
    expect(screen.queryByLabelText(/^(X client ID|YouTube client ID|TikTok client key|TikTok token server)$/)).toBeNull();
    expect(screen.getByLabelText("Credit the creator")).toBeChecked();
  });

  it("My Creators saves a facecam layout and creator rights with evidence", async () => {
    mockFetch(() => null);
    installWorker();
    await db.put<Streamer>("streamers", { id: undefined as unknown as number, platform: "twitch", platform_user_id: "77", username: "streamerone", display_name: "StreamerOne", monitoring_enabled: true, is_live: false, is_favorite: false, auto_record: false, priority: 0 } as unknown as Streamer);
    window.location.hash = "/streamers";
    render(<App />);
    await userEvent.click(await screen.findByText(/Clip layout & rights/));
    await userEvent.selectOptions(screen.getByLabelText("Vertical layout for StreamerOne"), "facecam_top");
    await userEvent.click(screen.getByRole("button", { name: "Top left" }));
    await userEvent.click(screen.getByRole("button", { name: "Save layout" }));
    await waitFor(async () => expect((await db.all<Streamer>("streamers"))[0]!.layout).toEqual({ kind: "facecam_top", facecam: { x: 0, y: 0, w: 0.25, h: 0.3 } }));
    await userEvent.selectOptions(screen.getByLabelText("Rights level"), "publishing");
    await userEvent.type(screen.getByLabelText("Rights evidence"), "Clipping programme terms, 2026-11-01");
    await userEvent.click(screen.getByRole("checkbox", { name: "YouTube Shorts" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /I confirm I have these rights/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save rights" }));
    await waitFor(async () => expect(await db.get("rights", "twitch:77")).toMatchObject({ status: "publishing", destinations: ["youtube"] }));
  });
});
