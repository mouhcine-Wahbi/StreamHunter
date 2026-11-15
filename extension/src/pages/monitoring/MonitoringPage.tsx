import { useEffect } from "react";
import { History, Radio } from "lucide-react";
import { Avatar } from "@/components/streamers/PlatformBadge";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { MonitoringCard } from "@/components/monitoring/MonitoringCard";
import { MonitoringToggle } from "@/components/monitoring/MonitoringToggle";
import { SessionActivity } from "@/components/monitoring/SessionActivity";
import { SessionMedia } from "@/components/monitoring/SessionMedia";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { useMonitoring } from "@/hooks/useMonitoring";
import type { MonitoringSession, MonitoringSessionStatus, Page, Streamer } from "@/types/api";
import { formatDateTime, formatDuration, formatRelative } from "@/utils/format";

const SESSION_TONE: Record<MonitoringSessionStatus, BadgeTone> = {
  active: "live",
  paused: "warn",
  ended: "neutral",
  error: "danger",
};

function LiveNow({ refreshKey }: { refreshKey: string | null }) {
  const live = useApiQuery<Page<Streamer>>("/api/v1/streams/live?limit=50");
  const { reload } = live;
  useEffect(() => reload(), [refreshKey, reload]);
  return (
    <Card>
      <CardHeader icon={<Radio className="size-4" />} title="Live now" description="Monitored streamers currently broadcasting." />
      <CardBody>
        <ApiStateView query={live} feature="live streams" compact>
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState compact icon={<Radio className="size-4" />} title="Nobody is live">
                Sessions open automatically when a monitored streamer goes live.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-ink-700/70">
                {page.items.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 py-2.5">
                    <Avatar src={s.profile_image_url} name={s.display_name} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-fg">{s.display_name}</span>
                        <PlatformBadge platform={s.platform} />
                      </div>
                      <div className="truncate text-xs text-fg-muted">
                        {[s.current_category, s.current_title].filter(Boolean).join(" · ") || "No title"}
                      </div>
                    </div>
                    <div className="text-right text-[11px] text-fg-subtle tabular">
                      {s.viewer_count !== null && <div>{s.viewer_count.toLocaleString()} viewers</div>}
                      {s.stream_started_at && <div>live {formatDuration(s.stream_started_at)}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </ApiStateView>
      </CardBody>
    </Card>
  );
}

export function MonitoringPage({ monitoring }: { monitoring: ReturnType<typeof useMonitoring> }) {
  // Refetch lists whenever a heartbeat lands (the worker updates lastSuccessAt).
  const refreshKey = monitoring.state.lastSuccessAt;
  const sessions = useApiQuery<Page<MonitoringSession>>("/api/v1/monitoring?limit=50");
  const { reload } = sessions;
  useEffect(() => reload(), [refreshKey, reload]);
  return (
    <>
      <PageHeader
        title="Live Monitoring"
        description="Monitoring runs while Chrome is open. If the browser closes, the backend pauses sessions automatically."
        actions={<MonitoringToggle monitoring={monitoring} />}
      />
      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-6">
          <MonitoringCard monitoring={monitoring} />
          <LiveNow refreshKey={refreshKey} />
        </div>
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
                        <span className="text-fg">{s.streamer_display_name ?? `Streamer #${s.streamer_id}`}</span>
                        <Badge tone={SESSION_TONE[s.status]}>{s.status}</Badge>
                        <span className="ml-auto text-xs text-fg-muted tabular">
                          {formatDateTime(s.started_at)} · {s.ended_at ? "ended" : formatDuration(s.started_at)} · last event{" "}
                          {formatRelative(s.last_event_at)}
                        </span>
                        {s.status === "active" ? (
                          <SessionActivity sessionId={s.id} />
                        ) : (
                          s.error_message && <p className="w-full text-xs text-danger">{s.error_message}</p>
                        )}
                        {s.status !== "active" && (
                          <details className="w-full">
                            <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg">Recording &amp; analysis</summary>
                            <SessionMedia session={s} onVodFound={reload} />
                          </details>
                        )}
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
