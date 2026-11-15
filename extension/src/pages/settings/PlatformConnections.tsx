import { useEffect } from "react";
import { Link2, Plug, Unplug } from "lucide-react";
import { ApiStateView } from "@/components/ApiStateView";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useAction } from "@/hooks/useAction";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import type { Platform } from "@/types/api";

/** Capability value as reported by the backend adapter (never computed in the UI). */
type CapabilityValue = boolean | string;

interface PlatformCapabilities {
  platform: Platform;
  configured: boolean;
  connection_status: string;
  capabilities: Record<string, CapabilityValue>;
  notes?: string[];
}

interface ConnectionStatus {
  platform: Platform;
  configured: boolean;
  connection_status: "not_connected" | "connected" | "expired" | "revoked" | "error";
  platform_username: string | null;
  scopes: string[];
  last_error: string | null;
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

const STATUS_TONE: Record<ConnectionStatus["connection_status"], BadgeTone> = {
  connected: "live",
  not_connected: "neutral",
  expired: "warn",
  revoked: "warn",
  error: "danger",
};

/** Refetch when the user comes back from the platform's consent tab. */
function useRefetchOnFocus(reload: () => void) {
  useEffect(() => {
    const onFocus = () => document.visibilityState === "visible" && reload();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [reload]);
}

function ConnectionControls({ platform, configured, onChanged }: { platform: Platform; configured: boolean; onChanged: () => void }) {
  const client = useApiClient();
  const status = useApiQuery<ConnectionStatus>(`/api/v1/auth/${platform}/status`);
  const reloadBoth = () => {
    status.reload();
    onChanged();
  };
  useRefetchOnFocus(status.reload);

  const connect = useAction(async () => {
    const { authorization_url } = await client.get<{ authorization_url: string }>(`/api/v1/auth/${platform}/authorize`);
    // Only ever open the platform's own consent page.
    const host = new URL(authorization_url).host;
    if (!["id.twitch.tv", "id.kick.com"].includes(host)) throw new Error("Unexpected authorization URL");
    await chrome.tabs.create({ url: authorization_url });
  });
  const disconnect = useAction(async () => {
    await client.post(`/api/v1/auth/${platform}/disconnect`);
    reloadBoth();
  });

  const s = status.data;
  const connected = s?.connection_status === "connected";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3">
      {s && (
        <Badge tone={STATUS_TONE[s.connection_status]}>
          {connected && s.platform_username ? `Connected as ${s.platform_username}` : s.connection_status.replace(/_/g, " ")}
        </Badge>
      )}
      <div className="ml-auto flex gap-2">
        {connected ? (
          <Button size="sm" variant="ghost" loading={disconnect.pending} icon={<Unplug className="size-3.5" />} onClick={() => void disconnect.run()}>
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!configured}
            loading={connect.pending}
            icon={<Plug className="size-3.5" />}
            onClick={() => void connect.run()}
            title={configured ? undefined : "The backend has no credentials for this platform"}
          >
            {s?.connection_status === "expired" || s?.connection_status === "error" ? "Reconnect" : "Connect account"}
          </Button>
        )}
      </div>
      {(connect.error || disconnect.error || s?.last_error) && (
        <p className="w-full text-xs text-warn">{connect.error ?? disconnect.error ?? s?.last_error}</p>
      )}
      {!connected && configured && (
        <p className="w-full text-[11px] text-fg-subtle">
          Opens {platform === "twitch" ? "Twitch" : "Kick"} in a new tab. After approving, come back here.
        </p>
      )}
    </div>
  );
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
                <Badge tone={p.configured ? "live" : "warn"}>{p.configured ? "configured on backend" : "not configured"}</Badge>
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
              <ConnectionControls platform={p.platform} configured={p.configured} onChanged={query.reload} />
            </Card>
          ))}
        </div>
      )}
    </ApiStateView>
  );
}
