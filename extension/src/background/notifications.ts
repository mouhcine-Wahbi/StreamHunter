import type { Settings } from "@/types/settings";

export interface StreamNotification {
  type: "streamer_live" | "streamer_offline";
  streamer_id: number;
  streamer_display_name: string;
  platform: "twitch" | "kick";
  title: string | null;
  category: string | null;
  at: string;
}

export const NOTIFICATION_PREFIX = "sh-live-";

/** Desktop notifications for streamers going live, if the user enabled them in Settings. */
export async function notifyStreamEvents(events: StreamNotification[], settings: Settings): Promise<void> {
  if (!settings.notifications.onStreamerLive || !chrome.notifications) return;
  const live = events.filter((e) => e.type === "streamer_live").slice(0, 5); // avoid a burst
  for (const e of live) {
    const platform = e.platform === "twitch" ? "Twitch" : "Kick";
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
