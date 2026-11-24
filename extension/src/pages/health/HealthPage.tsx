import { useEffect, useState } from "react";
import { Cpu, HardDrive, Plug, RotateCcw, Trash2 } from "lucide-react";
import { useStorageValue } from "@/hooks/useStorageValue";
import { COMPANION_KEY, type CompanionStatus } from "@/companion/client";
import { COMPANION_LABEL, COMPANION_TONE } from "@/pages/settings/CompanionSection";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, Dot } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { SystemCard } from "@/components/monitoring/SystemCard";
import { SchedulerCard } from "@/components/monitoring/SchedulerCard";
import { StreamsGrid } from "@/components/monitoring/StreamsGrid";
import type { ClipStats } from "@/components/monitoring/PipelineStatus";
import { useAction } from "@/hooks/useAction";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useCaptures } from "@/hooks/useCapture";
import type { useMonitoring } from "@/hooks/useMonitoring";
import { useSettings } from "@/hooks/useSettings";
import { enforceStorageLimits } from "@/local/clips";
import { db } from "@/local/db";
import type { LocalHighlight } from "@/local/highlights";
import type { Platform } from "@/types/api";
import { formatBytes, formatRelative } from "@/utils/format";

const LOW_DISK = 2 * 1024 ** 3;

/** 4.0: the optional local companion (state, tools, work folder). Details and setup in Settings → Companion. */
function CompanionCard() {
  const status = useStorageValue<CompanionStatus>(COMPANION_KEY);
  const tools = status?.tools ? Object.values(status.tools) : [];
  return (
    <Card>
      <CardHeader icon={<Cpu className="size-4" />} title="Companion" description="Local video tools for automatic editing (optional)." />
      <CardBody className="space-y-1 text-xs">
        <div className="flex items-center gap-2">
          <Badge tone={status ? COMPANION_TONE[status.state] : "neutral"}>{status ? COMPANION_LABEL[status.state] : "Not checked yet"}</Badge>
          {status && <span className="text-fg-subtle">checked {formatRelative(status.checked_at)}</span>}
        </div>
        {tools.length > 0 && (
          <p className="text-fg-muted" aria-label="Companion tools ready">
            {tools.filter((t) => t.ok).length} of {tools.length} tools ready
            {tools.some((t) => !t.ok) ? `: missing or too old: ${tools.filter((t) => !t.ok).map((t) => t.name).join(", ")}` : ""}
          </p>
        )}
        {status?.work_dir && <p className="text-fg-muted">Work folder uses {formatBytes(status.used_bytes ?? 0)}; {formatBytes(status.free_bytes ?? 0)} free on the disk.</p>}
        {status?.message && <p className="text-fg-muted">{status.message}</p>}
        <a href="#/settings" className="text-accent underline">
          Settings → Companion
        </a>
      </CardBody>
    </Card>
  );
}

/** Browser storage: what is used, whether Chrome may evict it, manual cleanup. */
function StorageCard() {
  const { settings } = useSettings();
  const stats = useApiQuery<ClipStats>("/api/v1/clips/stats");
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);
  const s = stats.data;
  const free = s?.storage_quota_bytes != null && s.storage_used_bytes != null ? s.storage_quota_bytes - s.storage_used_bytes : null;
  const cleanup = useAction(async () => {
    const r = await enforceStorageLimits(settings.storage, new Date());
    setNotice(r.deleted.length ? `Deleted ${r.deleted.length} old clip${r.deleted.length === 1 ? "" : "s"} (${formatBytes(r.freedBytes)}); favourites were kept.` : "Nothing to delete: clips are within your limits.");
    stats.reload();
  });
  const clearFailed = useAction(async () => {
    const failed = (await db.all<LocalHighlight>("highlights")).filter((h) => h.clip_status === "failed");
    for (const h of failed) await db.delete("highlights", h.id);
    setNotice(`Removed ${failed.length} failed clip entr${failed.length === 1 ? "y" : "ies"}.`);
  });
  const keep = useAction(async () => setPersisted((await navigator.storage?.persist?.()) ?? false));
  return (
    <Card>
      <CardHeader icon={<HardDrive className="size-4" />} title="Storage" description="Clips live in this browser's storage (IndexedDB). It isn't unlimited and is shared with the disk." />
      <CardBody className="space-y-2 text-xs">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <dt className="text-fg-subtle">Clips</dt>
          <dd className="text-right tabular text-fg">{s ? `${s.clips} · ${formatBytes(s.clip_bytes)}` : "—"}</dd>
          <dt className="text-fg-subtle">Versions (vertical, landscape, edited)</dt>
          <dd className="text-right tabular text-fg">{s?.version_bytes != null ? formatBytes(s.version_bytes) : "—"}</dd>
          <dt className="text-fg-subtle">Imported source files</dt>
          <dd className="text-right tabular text-fg">{s?.source_files != null ? `${s.source_files} · ${formatBytes(s.source_bytes ?? 0)}` : "—"}</dd>
          <dt className="text-fg-subtle">Your limit</dt>
          <dd className="text-right tabular text-fg">
            {formatBytes(settings.storage.maxTotalMb * 1_048_576)}
            {settings.storage.maxAgeDays ? `, ${settings.storage.maxAgeDays} days` : ""}
          </dd>
          <dt className="text-fg-subtle">Browser storage used</dt>
          <dd className="text-right tabular text-fg">{s?.storage_used_bytes != null ? `${formatBytes(s.storage_used_bytes)} of ${formatBytes(s.storage_quota_bytes)}` : "—"}</dd>
          <dt className="text-fg-subtle">Kept by Chrome</dt>
          <dd className="text-right text-fg">{persisted === null ? "unknown" : persisted ? "yes (won't be evicted)" : "not guaranteed"}</dd>
        </dl>
        {free !== null && free < LOW_DISK && (
          <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-2 text-danger">
            Only {formatBytes(free)} left for this browser. Recording pauses below 2 GB; delete clips or free disk space.
          </p>
        )}
        {persisted === false && (
          <p className="text-fg-muted">
            Chrome may delete this extension's data when the disk runs low. Ask Chrome to keep it:{" "}
            <button type="button" className="text-accent underline" onClick={() => void keep.run()}>
              keep my clips
            </button>
            .
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="secondary" loading={cleanup.pending} icon={<Trash2 className="size-3.5" />} onClick={() => void cleanup.run()}>
            Apply storage limits now
          </Button>
          <Button size="sm" variant="ghost" loading={clearFailed.pending} onClick={() => void clearFailed.run()}>
            Remove failed clip entries
          </Button>
        </div>
        {notice && <p className="text-fg-muted">{notice}</p>}
        {(cleanup.error || clearFailed.error) && <p className="text-danger">{cleanup.error ?? clearFailed.error}</p>}
      </CardBody>
    </Card>
  );
}

/** Platform connectivity: set up or not, and the last check's problem, per platform. */
function ConnectivityCard({ errors }: { errors: Record<string, string> }) {
  const caps = useApiQuery<{ platform: Platform; configured: boolean; auth_message: string }[]>("/api/v1/platforms/capabilities");
  return (
    <Card>
      <CardHeader icon={<Plug className="size-4" />} title="Platform connectivity" description="Live checks go straight from this browser to each platform's official API." />
      <CardBody className="space-y-2 text-xs">
        {(caps.data ?? []).map((p) => {
          const problem = errors[p.platform];
          return (
            <div key={p.platform} className="flex flex-wrap items-center gap-2">
              <PlatformBadge platform={p.platform} />
              <Badge tone={!p.configured ? "warn" : problem ? "danger" : "live"} icon={<Dot tone={!p.configured ? "warn" : problem ? "danger" : "live"} />}>
                {!p.configured ? "Not set up" : problem ? "Problem" : "OK"}
              </Badge>
              <span className="text-fg-muted">{problem ?? p.auth_message}</span>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

/** After restarts and failures: what was recovered and what needs you. */
function RecoveryCard() {
  const { note, slots } = useCaptures();
  const [interrupted, setInterrupted] = useState<number | null>(null);
  useEffect(() => {
    void db.all<LocalHighlight>("highlights").then((all) => setInterrupted(all.filter((h) => h.clip_status === "failed" && h.clip_error?.startsWith("Chrome or StreamHunter stopped")).length));
  }, []);
  return (
    <Card>
      <CardHeader icon={<RotateCcw className="size-4" />} title="Recovery" description="Recording can't survive Chrome closing, the Mac sleeping, or the extension restarting." />
      <CardBody className="space-y-1.5 text-xs text-fg-muted">
        <p>{slots.length ? `${slots.length} recorder slot${slots.length === 1 ? "" : "s"} running.` : "No recorder slot is running."}</p>
        {note && <p className="text-warn">{note}</p>}
        <p>
          {interrupted === null ? "…" : interrupted === 0 ? "No clip was lost to a restart." : `${interrupted} clip${interrupted === 1 ? " was" : "s were"} lost because Chrome or StreamHunter stopped while saving (marked failed in Top Highlights).`}
        </p>
        <p className="text-fg-subtle">
          After a Chrome restart, monitoring resumes by itself (Settings → Monitoring), but Chrome requires one action per recorder tab again: press Alt+Shift+R in each. To keep
          recording overnight, keep the Mac awake (System Settings → Battery/Energy, or `caffeinate`).
        </p>
      </CardBody>
    </Card>
  );
}

export function HealthPage({ monitoring }: { monitoring: ReturnType<typeof useMonitoring> }) {
  return (
    <>
      <PageHeader title="System Health" description={`Measured values only. Last live check ${formatRelative(monitoring.state.lastSuccessAt)}.`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <SystemCard />
          <StorageCard />
          <CompanionCard />
          <ConnectivityCard errors={monitoring.state.platformErrors ?? {}} />
        </div>
        <div className="space-y-6">
          <SchedulerCard monitoring={monitoring} compact />
          <RecoveryCard />
          <StreamsGrid />
        </div>
      </div>
    </>
  );
}
