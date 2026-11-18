import type { MonitoringState } from "@/types/monitoring";

const BADGES: Record<MonitoringState["status"], { text: string; color: string; title: string }> = {
  stopped: { text: "", color: "#000000", title: "StreamHunter — monitoring stopped" },
  starting: { text: "…", color: "#6366f1", title: "StreamHunter — starting monitoring" },
  active: { text: "ON", color: "#16a34a", title: "StreamHunter — monitoring active" },
  degraded: { text: "!", color: "#f97316", title: "StreamHunter — monitoring degraded" },
  offline: { text: "!", color: "#dc2626", title: "StreamHunter — Twitch/Kick/YouTube unreachable" },
  paused: { text: "II", color: "#64748b", title: "StreamHunter — monitoring paused" },
};

export async function renderBadge(state: MonitoringState): Promise<void> {
  const b = BADGES[state.status];
  await Promise.all([
    chrome.action.setBadgeText({ text: b.text }),
    chrome.action.setBadgeBackgroundColor({ color: b.color }),
    chrome.action.setTitle({ title: b.title }),
  ]);
}
