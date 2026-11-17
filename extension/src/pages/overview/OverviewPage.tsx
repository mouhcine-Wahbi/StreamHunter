import type { ReactNode } from "react";
import { Activity, Clapperboard, Plug, Radio, Sparkles, Users } from "lucide-react";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, Dot } from "@/components/ui/Badge";
import { MonitoringCard } from "@/components/monitoring/MonitoringCard";
import { HighlightRow } from "@/components/highlights/HighlightRow";
import { ApiStateView } from "@/components/ApiStateView";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { useMonitoring } from "@/hooks/useMonitoring";
import type { HighlightCandidate, Page, Platform, Streamer } from "@/types/api";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiError } from "@/services/api-client";

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function unavailableReason(error: Error | null): string {
  if (!error) return "";
  return error instanceof ApiError && error.code === "platform_not_configured" ? "Set up Twitch/Kick in Settings" : "Couldn't load";
}

/** Whether Twitch and Kick are set up (the editor's own app credentials). */
function PlatformsCard() {
  const caps = useApiQuery<{ platform: Platform; configured: boolean }[]>("/api/v1/platforms/capabilities");
  return (
    <Card>
      <CardHeader icon={<Plug className="size-4" />} title="Platforms" description="Checked directly from this browser, with your own apps." />
      <CardBody className="space-y-2 text-xs">
        {(caps.data ?? []).map((p) => (
          <div key={p.platform} className="flex items-center justify-between">
            <PlatformBadge platform={p.platform} />
            <Badge tone={p.configured ? "live" : "warn"} icon={<Dot tone={p.configured ? "live" : "warn"} />}>
              {p.configured ? "Ready" : "Not set up"}
            </Badge>
          </div>
        ))}
        {caps.data?.some((p) => !p.configured) && (
          <a href="#/settings" className="block text-accent underline">
            Add your app credentials in Settings → Platforms
          </a>
        )}
      </CardBody>
    </Card>
  );
}

function StatTile({ label, icon, value, error }: { label: string; icon: ReactNode; value: number | null; error: Error | null }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-fg-subtle">
        <span className="text-xs font-medium">{label}</span>
        {icon}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-fg tabular">{value ?? "—"}</div>
      <div className="mt-0.5 h-4 text-[11px] text-fg-subtle">{unavailableReason(error)}</div>
    </Card>
  );
}

export function OverviewPage({ monitoring }: { monitoring: ReturnType<typeof useMonitoring> }) {
  const streamers = useApiQuery<Page<Streamer>>("/api/v1/streamers?limit=1");
  const live = useApiQuery<Page<Streamer>>("/api/v1/streams/live?limit=1");
  const today = useApiQuery<Page<HighlightCandidate>>(
    `/api/v1/highlights?limit=1&date_from=${encodeURIComponent(startOfTodayIso())}`,
  );
  const clips = useApiQuery<Page<unknown>>("/api/v1/clips?limit=1");
  const recent = useApiQuery<Page<HighlightCandidate>>("/api/v1/highlights?limit=5");

  return (
    <>
      <PageHeader title="Overview" description="What StreamHunter is watching and what it has found." />

      <section aria-label="Statistics" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Monitored streamers" icon={<Users className="size-4" />} value={streamers.data?.total ?? null} error={streamers.error} />
        <StatTile label="Live now" icon={<Radio className="size-4" />} value={live.data?.total ?? null} error={live.error} />
        <StatTile label="Highlights today" icon={<Sparkles className="size-4" />} value={today.data?.total ?? null} error={today.error} />
        <StatTile label="Clips created" icon={<Clapperboard className="size-4" />} value={clips.data?.total ?? null} error={clips.error} />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader icon={<Activity className="size-4" />} title="Recent highlights" description="Latest detected moments across your watchlist." />
          <CardBody>
            <ApiStateView query={recent} feature="recent highlights">
              {(page) =>
                page.items.length === 0 ? (
                  <EmptyState icon={<Sparkles className="size-5" />} title="No highlights yet">
                    Highlights appear here once monitoring is active and a monitored streamer's chat reacts to something.
                  </EmptyState>
                ) : (
                  <div className="divide-y divide-ink-700/70">
                    {page.items.map((h) => (
                      <HighlightRow key={h.id} h={h} />
                    ))}
                  </div>
                )
              }
            </ApiStateView>
          </CardBody>
        </Card>

        <div className="space-y-6">
          <MonitoringCard monitoring={monitoring} />
          <PlatformsCard />
        </div>
      </div>
    </>
  );
}
