import { PLATFORM_LABEL, type Platform } from "@/types/api";
import type { Streamer } from "@/types/api";
import type { Settings } from "@/types/settings";
import type { LocalHighlight } from "@/local/highlights";

export interface StreamNotification {
  type: "streamer_live" | "streamer_offline" | "highlight_detected";
  streamer_id: number;
  streamer_display_name: string;
  platform: Platform;
  title: string | null;
  category: string | null;
  at: string;
  highlight_id?: number | null;
  score?: number | null;
}

export const NOTIFICATION_PREFIX = "sh-live-";
export const HIGHLIGHT_PREFIX = "sh-hl-";

const CATEGORY_LABEL: Record<string, string> = {
  funny_moment: "Funny moment",
  unexpected_reaction: "Unexpected reaction",
  emotional_moment: "Emotional moment",
  exciting_moment: "Exciting moment",
  audience_reaction: "Audience reaction",
};

/**
 * "Interesting moment" notification for a detected highlight, with an Open stream button.
 * Provisional highlights say so: there is no video unless that stream was being captured.
 */
export async function notifyHighlight(h: LocalHighlight, s: Pick<Streamer, "display_name">, settings: Settings): Promise<void> {
  if (!chrome.notifications || !settings.notifications.onHighlight || h.score < settings.detection.minHighlightScore) return;
  const label = CATEGORY_LABEL[h.category] ?? "Possible highlight";
  await chrome.notifications
    .create(`${HIGHLIGHT_PREFIX}${h.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: `${label} · ${s.display_name} (${Math.round(h.score)})`,
      message: `${h.reasons[0] ?? "Something is happening."}${h.has_video ? "" : " Open the stream and capture it to get clips."}`,
      buttons: [{ title: "Open stream" }, { title: "Review" }],
      priority: 1,
    })
    .catch(() => undefined);
}

/** Desktop notifications for streamers going live, if the user enabled them in Settings. */
export async function notifyStreamEvents(events: StreamNotification[], settings: Settings): Promise<void> {
  if (!chrome.notifications) return;
  if (settings.notifications.onHighlight) {
    const highlights = events
      .filter((e) => e.type === "highlight_detected" && (e.score ?? 0) >= settings.detection.minHighlightScore)
      .slice(0, 3);
    for (const e of highlights) {
      await chrome.notifications
        .create(`${HIGHLIGHT_PREFIX}${e.highlight_id ?? e.at}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
          title: `${CATEGORY_LABEL[e.category ?? ""] ?? "Highlight"} · ${e.streamer_display_name} (${Math.round(e.score ?? 0)})`,
          message: e.title ?? "Open StreamHunter to review it.",
          priority: 1,
        })
        .catch(() => undefined);
    }
  }
  if (!settings.notifications.onStreamerLive) return;
  const live = events.filter((e) => e.type === "streamer_live").slice(0, 5); // avoid a burst
  for (const e of live) {
    const platform = PLATFORM_LABEL[e.platform];
    await chrome.notifications
      .create(`${NOTIFICATION_PREFIX}${e.streamer_id}-${e.at}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: `${e.streamer_display_name} is live on ${platform}`,
        message: [e.title, e.category].filter(Boolean).join(" · ") || "Monitoring started for this stream.",
        priority: 0,
      })
      .catch(() => undefined);
  }
}
