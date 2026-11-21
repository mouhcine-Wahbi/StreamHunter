import { useState } from "react";
import { BellRing, Check, Clock, Square, X } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useStorageValue } from "@/hooks/useStorageValue";
import { useCaptures } from "@/hooks/useCapture";
import { useSettings } from "@/hooks/useSettings";
import { APPROVALS_KEY, type Approval, type ApprovalAction, type ApprovalStore } from "@/local/approvals";
import type { SchedulerSnapshot } from "@/background/capture-manager";
import { sendRequest } from "@/services/runtime";
import { formatRelative } from "@/utils/format";

const STATUS: Record<Approval["status"], { label: string; tone: BadgeTone }> = {
  pending: { label: "Needs your answer", tone: "accent" },
  snoozed: { label: "Remind me later", tone: "neutral" },
  approved: { label: "Approved", tone: "live" },
  declined: { label: "Declined", tone: "neutral" },
  expired: { label: "Not answered", tone: "neutral" },
};

/** Where an approved stream stands right now: recording, queued (with position) or waiting for a tab. */
function approvedState(a: Approval, snap: SchedulerSnapshot | undefined, recordingIds: Set<number>): string {
  if (recordingIds.has(a.streamerId)) return "Recording now.";
  const q = snap?.queue.find((x) => x.streamerId === a.streamerId);
  if (q) return q.detail;
  return "Starting at the next scheduling run.";
}

/** Recording requests: StreamHunter records a live stream only after you approve that broadcast. */
export function ApprovalsCard({ compact = false }: { compact?: boolean }) {
  const store = useStorageValue<ApprovalStore>(APPROVALS_KEY);
  const snap = useStorageValue<SchedulerSnapshot>("sh.scheduler");
  const { slots } = useCaptures();
  const { settings } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = store?.items ?? [];
  const open = items.filter((a) => a.endedAt === null);
  const pending = open.filter((a) => a.status === "pending" || a.status === "snoozed");
  const approved = open.filter((a) => a.status === "approved");
  const declined = open.filter((a) => a.status === "declined");
  const history = items.filter((a) => a.endedAt !== null);
  const recordingIds = new Set(slots.filter((s) => s.recording && s.streamerId !== null).map((s) => s.streamerId!));

  async function act(a: Approval, action: ApprovalAction) {
    setBusy(`${a.id}:${action}`);
    setError(null);
    try {
      await sendRequest({ type: "approval/decide", id: a.id, action });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your decision");
    } finally {
      setBusy(null);
    }
  }

  const btn = (a: Approval, action: ApprovalAction, label: string, variant: "live" | "secondary" | "ghost" | "danger", icon: React.ReactNode) => (
    <Button size="sm" variant={variant} icon={icon} loading={busy === `${a.id}:${action}`} disabled={busy !== null} onClick={() => void act(a, action)}>
      {label}
    </Button>
  );

  const row = (a: Approval, children: React.ReactNode, detail?: string) => (
    <li key={a.id} className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <PlatformBadge platform={a.platform} />
        <span className="font-medium text-fg">{a.streamerName}</span>
        <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
        {a.viewers !== null && <span className="text-fg-subtle tabular">{a.viewers.toLocaleString("en")} viewers</span>}
        <span className="ml-auto text-fg-subtle">live since {formatRelative(a.createdAt)}</span>
      </div>
      {(a.title || a.category) && <p className="mt-0.5 truncate text-fg-muted">{[a.category, a.title].filter(Boolean).join(" · ")}</p>}
      {detail && <p className="mt-0.5 text-fg-subtle">{detail}</p>}
      <div className="mt-1.5 flex flex-wrap gap-2">{children}</div>
    </li>
  );

  return (
    <Card>
      <CardHeader
        icon={<BellRing className="size-4" />}
        title="Recording requests"
        description="StreamHunter never records without your approval. Each approval covers one broadcast and ends with it."
        actions={pending.length > 0 ? <Badge tone="accent">{pending.length} waiting</Badge> : undefined}
      />
      <CardBody className="space-y-4 text-xs">
        {error && <p className="rounded-lg border border-danger/30 bg-danger-soft p-2 text-danger">{error}</p>}
        {!settings.notifications.approvalRequests && (
          <p className="text-fg-subtle">Desktop notifications for requests are off (Settings → Notifications); requests only appear here.</p>
        )}

        <section aria-label="Pending approvals">
          <h3 className="mb-1 font-semibold text-fg-muted">Pending approvals</h3>
          {pending.length === 0 ? (
            <p className="text-fg-subtle">No stream is waiting for your answer. When a streamer with "Ask to record" goes live, you'll be asked here and in a notification.</p>
          ) : (
            <ul className="divide-y divide-ink-700/70">
              {pending.map((a) =>
                row(
                  a,
                  <>
                    {btn(a, "approve", "Record", "live", <Check className="size-3.5" />)}
                    {btn(a, "decline", "Decline", "secondary", <X className="size-3.5" />)}
                    {a.status === "pending" && btn(a, "remind", `Remind me in ${settings.notifications.remindMinutes} min`, "ghost", <Clock className="size-3.5" />)}
                  </>,
                  a.status === "snoozed" && a.remindAt ? `Asking again ${formatRelative(a.remindAt)}.` : undefined,
                ),
              )}
            </ul>
          )}
        </section>

        <section aria-label="Approved streams">
          <h3 className="mb-1 font-semibold text-fg-muted">Approved streams</h3>
          {approved.length === 0 ? (
            <p className="text-fg-subtle">None.</p>
          ) : (
            <ul className="divide-y divide-ink-700/70">
              {approved.map((a) => row(a, btn(a, "stop", "Stop recording this stream", "danger", <Square className="size-3.5" />), approvedState(a, snap, recordingIds)))}
            </ul>
          )}
        </section>

        {declined.length > 0 && (
          <section aria-label="Declined streams">
            <h3 className="mb-1 font-semibold text-fg-muted">Declined (still live)</h3>
            <ul className="divide-y divide-ink-700/70">{declined.map((a) => row(a, btn(a, "approve", "Record after all", "secondary", <Check className="size-3.5" />), a.note ?? undefined))}</ul>
          </section>
        )}

        {!compact && (
          <section aria-label="Approval history">
            <h3 className="mb-1 font-semibold text-fg-muted">History</h3>
            {history.length === 0 ? (
              <p className="text-fg-subtle">Closed requests appear here when their broadcast ends.</p>
            ) : (
              <ul className="space-y-1">
                {history.slice(0, 30).map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <PlatformBadge platform={a.platform} />
                    <span className="font-medium text-fg">{a.streamerName}</span>
                    <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                    <span className="text-fg-subtle">{a.note}</span>
                    <span className="ml-auto text-fg-subtle">{formatRelative(a.endedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </CardBody>
    </Card>
  );
}
