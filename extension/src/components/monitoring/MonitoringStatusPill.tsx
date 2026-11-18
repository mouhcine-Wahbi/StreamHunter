import type { MonitoringStatus } from "@/types/monitoring";
import { Badge, Dot, type BadgeTone } from "@/components/ui/Badge";

export const STATUS_META: Record<
  MonitoringStatus,
  { label: string; tone: BadgeTone; dot: "live" | "warn" | "danger" | "neutral" | "accent"; description: string }
> = {
  stopped: { label: "Stopped", tone: "neutral", dot: "neutral", description: "Monitoring is off." },
  starting: { label: "Starting", tone: "accent", dot: "accent", description: "Checking your streamers on Twitch and Kick…" },
  active: {
    label: "Active",
    tone: "live",
    dot: "live",
    description: "Your monitoring list is checked on Twitch and Kick while Chrome is open. No stream has to be open.",
  },
  degraded: {
    label: "Degraded",
    tone: "warn",
    dot: "warn",
    description: "Some streamers couldn't be checked; the reason is shown below.",
  },
  paused: { label: "Paused", tone: "warn", dot: "warn", description: "Paused: no checks, chat or recording until you resume." },
  offline: {
    label: "Not checking",
    tone: "danger",
    dot: "danger",
    description: "Twitch/Kick couldn't be checked (setup, network or rate limit). Retrying with backoff.",
  },
};

export function MonitoringStatusPill({ status }: { status: MonitoringStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge tone={meta.tone} icon={<Dot tone={meta.dot} pulse={status === "active"} />}>
      {meta.label}
    </Badge>
  );
}
