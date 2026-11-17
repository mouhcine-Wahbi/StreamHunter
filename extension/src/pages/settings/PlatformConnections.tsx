import { useEffect, useState } from "react";
import { Link2, Plug, Unplug } from "lucide-react";
import { ApiStateView } from "@/components/ApiStateView";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";
import { getCredentials, setCredentials, type PlatformCredentials } from "@/platforms/credentials";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useAction } from "@/hooks/useAction";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import type { Platform } from "@/types/api";

/** Capability value as reported by the platform layer (never computed in the UI). */
type CapabilityValue = boolean | string;

interface PlatformCapabilities {
  platform: Platform;
  configured: boolean;
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

const APP_HELP: Record<Platform, { url: string; label: string; redirect: string }> = {
  twitch: { url: "https://dev.twitch.tv/console/apps", label: "dev.twitch.tv/console", redirect: "OAuth redirect URL: any (e.g. http://localhost)" },
  kick: { url: "https://kick.com/settings/developer", label: "kick.com/settings/developer", redirect: "Redirect URL: any (e.g. http://localhost)" },
};

/** The editor's own developer-app credentials for one platform (kept on this computer only). */
function CredentialsForm({ platform, onChanged }: { platform: Platform; onChanged: () => void }) {
  const client = useApiClient();
  const [creds, setCreds] = useState<PlatformCredentials | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void getCredentials().then((c) => {
      setCreds(c);
      setClientId(c[platform]?.clientId ?? "");
    });
  }, [platform]);
  const saved = creds?.[platform] ?? null;

  const save = useAction(async () => {
    setNotice(null);
    if (!clientId.trim() || !secret.trim()) throw new Error("Enter both the client ID and the client secret.");
    setCreds(await setCredentials(platform, { clientId, clientSecret: secret }));
    setSecret("");
    // Prove it works with one cheap call: the most-watched live channel.
    const live = await client.get<unknown[]>(`/api/v1/discover/live?platform=${platform}&limit=1`);
    setNotice(`Saved and working: ${platform === "twitch" ? "Twitch" : "Kick"} answered (${live.length} live channel checked).`);
    onChanged();
  });
  const remove = useAction(async () => {
    setCreds(await setCredentials(platform, null));
    setClientId("");
    setSecret("");
    setNotice("Removed from this computer.");
    onChanged();
  });

  return (
    <div className="mt-4 space-y-2 border-t border-ink-700 pt-3 text-xs">
      <p className="text-fg-muted">
        Your own {platform === "twitch" ? "Twitch" : "Kick"} app, created for free at{" "}
        <a className="text-accent underline" href={APP_HELP[platform].url} target="_blank" rel="noreferrer">
          {APP_HELP[platform].label}
        </a>{" "}
        ({APP_HELP[platform].redirect}). Stored only in this browser and sent only to {platform === "twitch" ? "Twitch" : "Kick"}.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label={`${platform} client ID`} placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
        <Input
          aria-label={`${platform} client secret`}
          placeholder={saved ? "Client secret (saved; enter again to change)" : "Client secret"}
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={save.pending} icon={<Plug className="size-3.5" />} onClick={() => void save.run()}>
          {saved ? "Update and test" : "Save and test"}
        </Button>
        {saved && (
          <Button size="sm" variant="ghost" loading={remove.pending} icon={<Unplug className="size-3.5" />} onClick={() => void remove.run()}>
            Remove
          </Button>
        )}
      </div>
      {notice && <p className="text-live">{notice}</p>}
      {(save.error || remove.error) && (
        <p role="alert" className="text-danger">
          {save.error ?? remove.error}
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
                <Badge tone={p.configured ? "live" : "warn"}>{p.configured ? "app credentials saved" : "not configured"}</Badge>
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
              <CredentialsForm platform={p.platform} onChanged={query.reload} />
            </Card>
          ))}
        </div>
      )}
    </ApiStateView>
  );
}
