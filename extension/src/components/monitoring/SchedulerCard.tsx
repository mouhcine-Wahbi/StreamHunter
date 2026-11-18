import { useState } from "react";
import { AppWindow, ChevronDown, ListOrdered } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, Dot } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useStorageValue } from "@/hooks/useStorageValue";
import { useCaptures } from "@/hooks/useCapture";
import { useSettings } from "@/hooks/useSettings";
import type { SchedulerSnapshot } from "@/background/capture-manager";
import type { useMonitoring } from "@/hooks/useMonitoring";
import { streamUrl } from "@/local/streamers";
import type { Platform } from "@/types/api";
import { formatDuration, formatRelative } from "@/utils/format";

const REASON_LABEL: Record<string, string> = {
  waiting_for_slot: "Queued",
  retry_wait: "Retrying later",
  gave_up: "Failed",
  auto_record_off: "Auto-record off",
  recorded_elsewhere: "Manual capture",
};

/**
 * Opens the recorder tabs the editor still needs, in their own window. Chrome only lets an
 * extension record a tab after one action on that tab, so each tab then needs Alt+Shift+R (or the
 * toolbar icon) once.
 */
async function openRecorderWindow(urls: string[]) {
  await chrome.windows?.create?.({ url: urls, focused: true });
}

/** Hybrid monitoring scheduler: who records, who waits, and why. */
export function SchedulerCard({ monitoring, compact = false }: { monitoring: ReturnType<typeof useMonitoring>; compact?: boolean }) {
  const snap = useStorageValue<SchedulerSnapshot>("sh.scheduler");
  const { slots } = useCaptures();
  const { settings } = useSettings();
  const [open, setOpen] = useState<number | null>(null);
  const max = settings.recording.maxStreams;
  const armed = slots.length;
  const recording = slots.filter((s) => s.recording);
  const missing = Math.max(0, max - armed);
  const queued = snap?.queue.filter((q) => q.reason === "waiting_for_slot") ?? [];
  const healthy = monitoring.state.enabled && !monitoring.state.paused && (monitoring.state.status === "active" || monitoring.state.status === "degraded");

  const setupUrls = () => {
    const live = queued.slice(0, missing);
    const urls = live.map((q) => {
      const p = snap?.priorities.find((x) => x.streamerId === q.streamerId);
      return p ? streamUrl({ platform: p.platform as Platform, username: p.username, platform_user_id: p.platformUserId }) : "https://www.twitch.tv/";
    });
    while (urls.length < missing) urls.push("https://www.twitch.tv/");
    return urls;
  };

  return (
    <Card>
      <CardHeader
        icon={<ListOrdered className="size-4" />}
        title="Scheduler"
        description={`Records the ${max} highest-priority live streamers at once and queues the rest. Priority favours predicted highlight potential, not just viewers.`}
        actions={
          <Badge tone={healthy ? "live" : monitoring.state.enabled ? "warn" : "neutral"} icon={<Dot tone={healthy ? "live" : monitoring.state.enabled ? "warn" : "neutral"} />}>
            {!monitoring.state.enabled ? "Stopped" : monitoring.state.paused ? "Paused" : healthy ? "Running" : "Degraded"}
          </Badge>
        }
      />
      <CardBody className="space-y-4 text-xs">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Slots", `${recording.length} recording / ${max}`],
            ["Recorder tabs", `${armed} armed`],
            ["Live", `${snap?.live ?? "—"} of ${snap?.tracked ?? "—"} tracked`],
            ["Queued", String(queued.length)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-ink-700 bg-ink-850 p-2">
              <dt className="text-[11px] text-fg-subtle">{k}</dt>
              <dd className="mt-0.5 font-medium text-fg tabular">{v}</dd>
            </div>
          ))}
        </dl>
        {missing > 0 && (
          <div className="rounded-lg border border-warn/25 bg-warn-soft p-3 text-warn">
            <p>
              {armed === 0 ? "No recorder tab is armed, so nothing can be recorded." : `${missing} of ${max} slots have no recorder tab.`} Chrome only records a tab after you act
              on it once: open the tabs, then press <kbd className="rounded bg-ink-800 px-1 text-fg">Alt+Shift+R</kbd> in each (or click the StreamHunter icon → Use this tab
              as a recorder).
            </p>
            <Button className="mt-2" size="sm" variant="secondary" icon={<AppWindow className="size-3.5" />} onClick={() => void openRecorderWindow(setupUrls())}>
              Open {missing} recorder tab{missing === 1 ? "" : "s"}
            </Button>
          </div>
        )}

        <section aria-label="Recording">
          <h3 className="mb-1 font-semibold text-fg-muted">Recording</h3>
          {recording.length === 0 ? (
            <p className="text-fg-subtle">Nothing is being recorded right now.</p>
          ) : (
            <ul className="space-y-1">
              {recording.map((s) => {
                const p = snap?.priorities.find((x) => x.streamerId === s.streamerId);
                return (
                  <li key={s.tabId} className="flex flex-wrap items-center gap-2">
                    {s.platform && <PlatformBadge platform={s.platform} />}
                    <span className="font-medium text-fg">{s.channel}</span>
                    <span className="text-fg-subtle">priority {p?.total ?? "—"}</span>
                    <span className="ml-auto text-fg-subtle tabular">for {formatDuration(s.assignedAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Live but not recorded">
          <h3 className="mb-1 font-semibold text-fg-muted">Live but not recorded</h3>
          {!snap || snap.queue.length === 0 ? (
            <p className="text-fg-subtle">Every live Auto-record streamer is being recorded.</p>
          ) : (
            <ul className="space-y-1.5">
              {snap.queue.slice(0, compact ? 4 : 50).map((q) => (
                <li key={q.streamerId}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{q.name}</span>
                    <Badge tone={q.reason === "waiting_for_slot" ? "accent" : q.reason === "gave_up" ? "danger" : "neutral"}>{REASON_LABEL[q.reason] ?? q.reason}</Badge>
                    {q.total !== null && <span className="text-fg-subtle">priority {q.total}</span>}
                  </div>
                  <p className="text-fg-subtle">{q.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {!compact && snap && snap.priorities.length > 0 && (
          <section aria-label="Priority scores">
            <h3 className="mb-1 font-semibold text-fg-muted">Priority scores</h3>
            <ul className="divide-y divide-ink-700/70">
              {snap.priorities.map((p) => (
                <li key={p.streamerId} className="py-1.5">
                  <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={open === p.streamerId} onClick={() => setOpen(open === p.streamerId ? null : p.streamerId)}>
                    <PlatformBadge platform={p.platform as Platform} />
                    <span className="font-medium text-fg">{p.name}</span>
                    <span className="ml-auto font-semibold text-fg tabular">{p.total}</span>
                    <ChevronDown className={`size-3.5 text-fg-subtle transition ${open === p.streamerId ? "rotate-180" : ""}`} />
                  </button>
                  {open === p.streamerId && (
                    <ul className="mt-1 space-y-0.5 pl-1 text-fg-subtle">
                      {p.explain.map((e) => (
                        <li key={e}>· {e}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {snap && snap.failures.length > 0 && (
          <section aria-label="Recording failures">
            <h3 className="mb-1 font-semibold text-fg-muted">Recording failures</h3>
            <ul className="space-y-1 text-danger">
              {snap.failures.map((f) => (
                <li key={f.streamerId}>
                  {f.name}: {f.error} ({f.failures}×{f.retryAt ? `, retry ${formatRelative(f.retryAt)}` : ", waiting for the next broadcast"})
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-[11px] text-fg-subtle">
          Last live check {formatRelative(monitoring.state.lastSuccessAt)} · last scheduling {formatRelative(snap?.at)} · last active recording{" "}
          {formatRelative(snap?.lastRecordingAt)}
        </p>
      </CardBody>
    </Card>
  );
}
