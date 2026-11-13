import { History } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { MonitoringCard } from "@/components/monitoring/MonitoringCard";
import { MonitoringToggle } from "@/components/monitoring/MonitoringToggle";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { useMonitoring } from "@/hooks/useMonitoring";
import type { MonitoringSession, MonitoringSessionStatus, Page } from "@/types/api";
import { formatDateTime, formatDuration, formatRelative } from "@/utils/format";

const SESSION_TONE: Record<MonitoringSessionStatus, BadgeTone> = {
  active: "live",
  paused: "warn",
  ended: "neutral",
  error: "danger",
};

export function MonitoringPage({ monitoring }: { monitoring: ReturnType<typeof useMonitoring> }) {
  const sessions = useApiQuery<Page<MonitoringSession>>("/api/v1/monitoring?limit=50");
  return (
    <>
      <PageHeader
        title="Live Monitoring"
        description="Monitoring runs while Chrome is open. If the browser closes, the backend pauses sessions automatically."
        actions={<MonitoringToggle monitoring={monitoring} />}
      />
      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <MonitoringCard monitoring={monitoring} />
        <Card>
          <CardHeader icon={<History className="size-4" />} title="Sessions" description="One session per streamer broadcast." />
          <CardBody>
            <ApiStateView query={sessions} feature="monitoring sessions">
              {(page) =>
                page.items.length === 0 ? (
                  <EmptyState icon={<History className="size-5" />} title="No sessions yet">
                    A session starts when a monitored streamer goes live while monitoring is active.
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-ink-700/70">
                    {page.items.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                        <PlatformBadge platform={s.platform} />
                        <span className="text-fg">Streamer #{s.streamer_id}</span>
                        <Badge tone={SESSION_TONE[s.status]}>{s.status}</Badge>
                        <span className="ml-auto text-xs text-fg-muted tabular">
                          {formatDateTime(s.started_at)} · {s.ended_at ? "ended" : formatDuration(s.started_at)} · last event{" "}
                          {formatRelative(s.last_event_at)}
                        </span>
                        {s.error_message && <p className="w-full text-xs text-danger">{s.error_message}</p>}
                      </li>
                    ))}
                  </ul>
                )
              }
            </ApiStateView>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
