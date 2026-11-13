import { Link2 } from "lucide-react";
import { ApiStateView } from "@/components/ApiStateView";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { Platform } from "@/types/api";

/** Capability value as reported by the backend adapter (never computed in the UI). */
type CapabilityValue = boolean | string;

interface PlatformCapabilities {
  platform: Platform;
  connection_status: string;
  capabilities: Record<string, CapabilityValue>;
  notes?: string[];
}

function tone(v: CapabilityValue): BadgeTone {
  if (v === true || v === "supported") return "live";
  if (v === false || v === "unsupported") return "neutral";
  return "warn";
}

function label(v: CapabilityValue): string {
  if (v === true) return "supported";
  if (v === false) return "unsupported";
  return v.replace(/_/g, " ");
}

export function PlatformConnections() {
  const query = useApiQuery<PlatformCapabilities[]>("/api/v1/platforms/capabilities");
  return (
    <ApiStateView query={query} feature="platform connections" compact>
      {(platforms) => (
        <div className="space-y-3">
          {platforms.map((p) => (
            <Card key={p.platform} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Link2 className="size-4 text-fg-subtle" />
                  <PlatformBadge platform={p.platform} />
                </div>
                <Badge tone={p.connection_status === "connected" ? "live" : "warn"}>{p.connection_status.replace(/_/g, " ")}</Badge>
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {Object.entries(p.capabilities).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-2 text-xs">
                    <dt className="text-fg-muted">{k.replace(/_/g, " ")}</dt>
                    <dd>
                      <Badge tone={tone(v)}>{label(v)}</Badge>
                    </dd>
                  </div>
                ))}
              </dl>
              {p.notes?.map((n) => (
                <p key={n} className="mt-2 text-xs text-fg-subtle">
                  {n}
                </p>
              ))}
            </Card>
          ))}
        </div>
      )}
    </ApiStateView>
  );
}
