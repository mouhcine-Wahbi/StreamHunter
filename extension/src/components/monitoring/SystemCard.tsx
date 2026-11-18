import { Cpu } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, Dot } from "@/components/ui/Badge";
import { useStorageValue } from "@/hooks/useStorageValue";
import { useSettings } from "@/hooks/useSettings";
import { SYSTEM_KEY, type SystemLoad } from "@/types/capture";
import { formatBytes, formatRelative } from "@/utils/format";

function Meter({ label, value, max, text }: { label: string; value: number | null; max: number; text: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div>
      <div className="flex justify-between text-[11px] text-fg-subtle">
        <span>{label}</span>
        <span className="tabular">{text}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-700" role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${pct >= 90 ? "bg-danger" : pct >= 75 ? "bg-warn" : "bg-accent"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Machine load as measured by the overload protection (while recording). */
export function SystemCard() {
  const load = useStorageValue<SystemLoad>(SYSTEM_KEY);
  const { settings } = useSettings();
  const memUsed = load?.memCapacityBytes && load.memAvailableBytes !== null ? load.memCapacityBytes - load.memAvailableBytes : null;
  return (
    <Card>
      <CardHeader
        icon={<Cpu className="size-4" />}
        title="System"
        description={settings.recording.protectResources ? "Measured while recording. StreamHunter slows down or pauses streams before the Mac is overloaded." : "Overload protection is off (Settings → Recording)."}
        actions={
          load ? (
            <Badge tone={load.overloaded ? "danger" : "live"} icon={<Dot tone={load.overloaded ? "danger" : "live"} />}>
              {load.overloaded ? "Overloaded" : "OK"}
            </Badge>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">
        {!load ? (
          <p className="text-xs text-fg-muted">Measured once a recording runs.</p>
        ) : (
          <>
            <Meter label="CPU (whole Mac)" value={load.cpuPercent} max={100} text={load.cpuPercent === null ? "—" : `${Math.round(load.cpuPercent)}%`} />
            <Meter
              label="Memory in use"
              value={memUsed}
              max={load.memCapacityBytes ?? 1}
              text={memUsed === null ? "—" : `${formatBytes(memUsed)} of ${formatBytes(load.memCapacityBytes)}`}
            />
            <Meter
              label="Browser storage"
              value={load.storageUsedBytes}
              max={load.storageQuotaBytes ?? 1}
              text={load.storageUsedBytes === null ? "—" : `${formatBytes(load.storageUsedBytes)} of ${formatBytes(load.storageQuotaBytes)}`}
            />
            {load.overloaded && load.reason && <p className="text-xs text-danger">Overloaded: {load.reason}. New streams won't start until it recovers.</p>}
            {!load.overloaded && load.reason && <p className="text-xs text-warn">High load: {load.reason}. StreamHunter acts if it lasts about 30 s.</p>}
            {load.lastAction && <p className="text-xs text-fg-muted">{load.lastAction}</p>}
            <p className="text-[11px] text-fg-subtle">Updated {formatRelative(load.at)}</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
