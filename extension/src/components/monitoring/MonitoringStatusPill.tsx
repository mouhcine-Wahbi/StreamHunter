import type { MonitoringStatus } from "@/types/monitoring";
import { Badge, Dot, type BadgeTone } from "@/components/ui/Badge";

export const STATUS_META: Record<
  MonitoringStatus,
  { label: string; tone: BadgeTone; dot: "live" | "warn" | "danger" | "neutral" | "accent"; description: string }
> = {
  stopped: { label: "Stopped", tone: "neutral", dot: "neutral", description: "Monitoring is off." },
  starting: { label: "Starting", tone: "accent", dot: "accent", description: "Contacting the backend…" },
  active: {
    label: "Active",
    tone: "live",
    dot: "live",
    description: "The backend holds a monitoring lease while this browser stays open.",
  },
  degraded: {
    label: "Degraded",
    tone: "warn",
    dot: "warn",
    description: "The backend is reachable but did not accept the heartbeat.",
  },
  offline: {
    label: "Backend offline",
    tone: "danger",
    dot: "danger",
    description: "The backend could not be reached. Retrying with backoff.",
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
