import { useState } from "react";
import { ExternalLink, RefreshCw, Trash2, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { Avatar, LiveBadge, PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import { useAction } from "@/hooks/useAction";
import { streamUrl } from "@/local/streamers";
import type { Page, Streamer } from "@/types/api";
import { formatRelative } from "@/utils/format";
import { sendRequest } from "@/services/runtime";

interface RefreshResult {
  checked: number;
  live: number;
  skipped_recent: number;
  unavailable: Record<string, string>;
}

function StreamerCard({ s, onChanged }: { s: Streamer; onChanged: () => void }) {
  const client = useApiClient();
  const [confirming, setConfirming] = useState(false);
  const toggle = useAction(async (next: boolean) => {
    await client.patch(`/api/v1/streamers/${s.id}`, { monitoring_enabled: next });
    onChanged();
  });
  const autoRecord = useAction(async (next: boolean) => {
    await client.patch(`/api/v1/streamers/${s.id}`, { auto_record: next, ...(next ? { monitoring_enabled: true } : {}) });
    // Let the recorder pick it up now (only inside the installed extension).
    await sendRequest({ type: "capture/sync" }).catch(() => undefined);
    onChanged();
  });
  const remove = useAction(async () => {
    await client.delete(`/api/v1/streamers/${s.id}`);
    onChanged();
  });

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <Avatar src={s.profile_image_url} name={s.display_name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-fg">{s.display_name}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <PlatformBadge platform={s.platform} />
            <LiveBadge isLive={s.is_live} />
          </div>
        </div>
      </div>
      <div className="mt-3 min-h-8 text-xs text-fg-muted">
        <div className="truncate">{s.current_category ?? "No category"}</div>
        {s.current_title && <div className="truncate text-fg-subtle">{s.current_title}</div>}
        <div className="mt-1 text-[11px] text-fg-subtle">
          {s.status_checked_at ? `Status checked ${formatRelative(s.status_checked_at)}` : "Status not checked yet"}
          {s.is_live && s.viewer_count !== null ? ` · ${s.viewer_count.toLocaleString()} viewers` : ""}
        </div>
      </div>
      {(toggle.error || remove.error || autoRecord.error) && <p className="mt-2 text-xs text-danger">{toggle.error ?? remove.error ?? autoRecord.error}</p>}
      <div className="mt-4 flex items-center justify-between border-t border-ink-700 pt-3">
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <Switch
            checked={s.monitoring_enabled}
            disabled={toggle.pending}
            onChange={(v) => void toggle.run(v)}
            label={`Monitor ${s.display_name}`}
          />
          Monitor
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-muted" title="Record this streamer automatically on the recorder tab while live">
          <Switch checked={Boolean(s.auto_record)} disabled={autoRecord.pending} onChange={(v) => void autoRecord.run(v)} label={`Auto-record ${s.display_name}`} />
          Auto-record
        </label>
        {confirming ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" loading={remove.pending} onClick={() => void remove.run()}>
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Open ${s.display_name}'s stream`}
            onClick={() => void chrome.tabs.create({ url: streamUrl(s) })}
            icon={<ExternalLink className="size-3.5" />}
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${s.display_name}`}
            onClick={() => setConfirming(true)}
            icon={<Trash2 className="size-3.5" />}
          />
          </div>
        )}
      </div>
    </Card>
  );
}

export function StreamersPage({ onDiscover }: { onDiscover: () => void }) {
  const query = useApiQuery<Page<Streamer>>("/api/v1/streamers?limit=100");
  const client = useApiClient();
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useAction(async () => {
    const r = await client.post<RefreshResult>("/api/v1/streams/refresh");
    const problems = Object.entries(r.unavailable).map(([p, msg]) => `${p}: ${msg}`);
    setNotice(
      [`Checked ${r.checked}${r.skipped_recent ? ` (${r.skipped_recent} checked in the last 30 s)` : ""}, ${r.live} live.`, ...problems].join(" "),
    );
    query.reload();
  });
  return (
    <>
      <PageHeader
        title="My Streamers"
        description="Channels on your watchlist. Monitor checks live status and chat; Auto-record also records the stream on your recorder tab while it is live."
        actions={
          <Button variant="secondary" size="sm" loading={refresh.pending} icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh.run()}>
            Refresh status
          </Button>
        }
      />
      {(notice || refresh.error) && (
        <p role="status" className="-mt-3 mb-4 text-xs text-fg-muted">
          {refresh.error ?? notice}
        </p>
      )}
      <ApiStateView query={query} feature="your watchlist">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState
              icon={<Users className="size-5" />}
              title="Your watchlist is empty"
              action={
                <Button variant="primary" size="sm" onClick={onDiscover}>
                  Discover streamers
                </Button>
              }
            >
              Add Twitch or Kick channels to start monitoring them.
            </EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {page.items.map((s) => (
                <StreamerCard key={s.id} s={s} onChanged={query.reload} />
              ))}
            </div>
          )
        }
      </ApiStateView>
    </>
  );
}
