import type { ReactNode } from "react";
import { Activity, BellRing, Clapperboard, Film, HardDrive, ListOrdered, Plug, Sparkles, Timer, Users, Video } from "lucide-react";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, Dot } from "@/components/ui/Badge";
import { MonitoringCard } from "@/components/monitoring/MonitoringCard";
import { MonitoringToggle } from "@/components/monitoring/MonitoringToggle";
import { STATUS_META } from "@/components/monitoring/MonitoringStatusPill";
import { PipelineStatus, type ClipStats } from "@/components/monitoring/PipelineStatus";
import { SystemCard } from "@/components/monitoring/SystemCard";
import { SchedulerCard } from "@/components/monitoring/SchedulerCard";
import { ApprovalsCard } from "@/components/monitoring/ApprovalsCard";
import { APPROVALS_KEY, type ApprovalStore } from "@/local/approvals";
import { useStorageValue } from "@/hooks/useStorageValue";
import type { SchedulerSnapshot } from "@/background/capture-manager";
import { formatRelative } from "@/utils/format";
import { useCapture } from "@/hooks/useCapture";
import { useSettings } from "@/hooks/useSettings";
import { ClipCard } from "@/pages/clips/ClipCard";
import type { LocalClip } from "@/local/clips";
import { formatBytes, formatSeconds } from "@/utils/format";
import { ApiStateView } from "@/components/ApiStateView";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { useMonitoring } from "@/hooks/useMonitoring";
import type { Page, Platform, Streamer } from "@/types/api";
import { EmptyState } from "@/components/ui/EmptyState";

/** Whether Twitch, Kick and YouTube are set up (the editor's own app credentials). */
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

function StatTile({ label, icon, value, sub }: { label: string; icon: ReactNode; value: ReactNode; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-fg-subtle">
        <span className="text-xs font-medium">{label}</span>
        {icon}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-fg tabular">{value ?? "—"}</div>
      <div className="mt-0.5 h-4 truncate text-[11px] text-fg-subtle">{sub ?? ""}</div>
    </Card>
  );
}

export function OverviewPage({ monitoring }: { monitoring: ReturnType<typeof useMonitoring> }) {
  const { state: capture, slots } = useCapture();
  const recordingNames = slots.filter((x) => x.recording).map((x) => x.channel ?? "?");
  const streamers = useApiQuery<Page<Streamer>>("/api/v1/streamers?limit=500");
  const stats = useApiQuery<ClipStats>(`/api/v1/clips/stats?_=${capture.clips}:${capture.lastClipAt ?? ""}`);
  const recent = useApiQuery<Page<LocalClip>>(`/api/v1/clips?limit=4&_=${capture.lastClipAt ?? ""}`);
  const settings = useSettings();
  const monitored = streamers.data?.items.filter((s) => s.monitoring_enabled) ?? [];
  const s = stats.data;
  const limit = settings.settings.storage.maxTotalMb * 1_048_576;
  const status = STATUS_META[monitoring.state.status];
  const snap = useStorageValue<SchedulerSnapshot>("sh.scheduler");
  const approvals = useStorageValue<ApprovalStore>(APPROVALS_KEY);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Start monitoring, leave Chrome running, and come back to ranked clips."
        actions={<MonitoringToggle monitoring={monitoring} />}
      />

      <section aria-label="Statistics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Monitoring" icon={<Activity className="size-4" />} value={status.label} sub={snap ? `Scheduled ${formatRelative(snap.at)}` : "Scheduler not run yet"} />
        <StatTile
          label="Tracked streamers"
          icon={<Users className="size-4" />}
          value={streamers.data ? monitored.length : null}
          sub={`${monitored.filter((x) => x.is_live).length} live now`}
        />
        <StatTile
          label="Recording"
          icon={<Video className="size-4" />}
          value={`${recordingNames.length} / ${settings.settings.recording.maxStreams}`}
          sub={recordingNames.length ? recordingNames.join(", ") : "Not recording"}
        />
        <StatTile
          label="Pending approvals"
          icon={<BellRing className="size-4" />}
          value={approvals ? approvals.items.filter((a) => a.endedAt === null && (a.status === "pending" || a.status === "snoozed")).length : 0}
          sub="Live streams waiting for your answer"
        />
        <StatTile label="Queued" icon={<ListOrdered className="size-4" />} value={snap ? snap.queue.filter((q) => q.reason === "waiting_for_slot").length : null} sub="Approved, waiting for a slot" />
        <StatTile label="Clips generated" icon={<Clapperboard className="size-4" />} value={s?.clips ?? null} sub={s ? `${s.favorites} favourite${s.favorites === 1 ? "" : "s"}` : ""} />
        <StatTile label="Recording time" icon={<Timer className="size-4" />} value={s ? formatSeconds(s.recorded_seconds) : null} sub="Total video recorded" />
        <StatTile label="Clip footage" icon={<Film className="size-4" />} value={s ? formatSeconds(s.clip_seconds) : null} sub="Total length of saved clips" />
        <StatTile
          label="Storage used"
          icon={<HardDrive className="size-4" />}
          value={s ? formatBytes(s.clip_bytes) : null}
          sub={`Limit ${formatBytes(limit)}${s?.storage_quota_bytes ? ` · browser allows ${formatBytes(s.storage_quota_bytes)}` : ""}`}
        />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              icon={<Sparkles className="size-4" />}
              title="Recent highlights"
              description="The latest clips StreamHunter recorded."
              actions={
                <a href="#/highlights" className="text-xs text-accent underline">
                  Top Highlights
                </a>
              }
            />
            <CardBody>
              <ApiStateView query={recent} feature="recent clips">
                {(page) =>
                  page.items.length === 0 ? (
                    <EmptyState icon={<Sparkles className="size-5" />} title="No clips yet">
                      1. Add streamers in My Streamers ("Ask to record" is on by default). 2. Live Monitoring → Open recorder tabs, then press Alt+Shift+R
                      in each. 3. Start monitoring. When a streamer goes live, approve the recording request; clips appear here.
                    </EmptyState>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {page.items.map((c) => (
                        <ClipCard key={c.id} c={c} onChanged={() => recent.reload()} />
                      ))}
                    </div>
                  )
                }
              </ApiStateView>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <ApprovalsCard compact />
          <SchedulerCard monitoring={monitoring} compact />
          <PipelineStatus monitoring={monitoring} />
          <SystemCard />
          <MonitoringCard monitoring={monitoring} />
          <PlatformsCard />
        </div>
      </div>
    </>
  );
}
