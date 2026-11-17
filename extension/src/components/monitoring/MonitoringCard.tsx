import { RefreshCw, Radio } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { MonitoringStatusPill, STATUS_META } from "./MonitoringStatusPill";
import { MonitoringToggle } from "./MonitoringToggle";
import type { useMonitoring } from "@/hooks/useMonitoring";
import { formatDuration, formatRelative } from "@/utils/format";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-xs">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="truncate text-right text-fg-muted tabular">{value}</dd>
    </div>
  );
}

export function MonitoringCard({ monitoring }: { monitoring: ReturnType<typeof useMonitoring> }) {
  const { state, busy, error, checkNow } = monitoring;
  return (
    <Card>
      <CardHeader
        icon={<Radio className="size-4" />}
        title="Browser monitoring"
        description={STATUS_META[state.status].description}
        actions={<MonitoringStatusPill status={state.status} />}
      />
      <CardBody>
        <dl className="divide-y divide-ink-700/70 border-y border-ink-700/70">
          <Row label="Running for" value={state.enabled ? formatDuration(state.enabledAt) : "—"} />
          <Row label="Last status check" value={formatRelative(state.lastSuccessAt)} />
          <Row
            label="Live now / active sessions"
            value={state.enabled && state.liveCount !== null ? `${state.liveCount} / ${state.activeSessions ?? 0}` : "—"}
          />
          <Row
            label="Next retry"
            value={state.enabled && state.nextAttemptAt ? formatRelative(state.nextAttemptAt) : "—"}
          />
        </dl>
        {(state.lastError || error) && (
          <p role="alert" className="mt-3 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
            {error ?? state.lastError}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <MonitoringToggle monitoring={monitoring} />
          <Button
            variant="ghost"
            onClick={checkNow}
            disabled={busy}
            icon={<RefreshCw className="size-3.5" aria-hidden />}
          >
            Check now
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
