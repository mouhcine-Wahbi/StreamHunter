import { useState, type FormEvent } from "react";
import { ExternalLink, Plus, RefreshCw, Star, Trash2, Users } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Field";
import { useStorageValue } from "@/hooks/useStorageValue";
import { useCaptures } from "@/hooks/useCapture";
import type { SchedulerSnapshot } from "@/background/capture-manager";
import { channelFromUrl } from "@/types/capture";
import { cn } from "@/utils/cn";
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
import { PLATFORM_LABEL, PLATFORMS, type Page, type Platform, type Streamer } from "@/types/api";
import { formatRelative } from "@/utils/format";
import { sendRequest } from "@/services/runtime";

interface RefreshResult {
  checked: number;
  live: number;
  skipped_recent: number;
  unavailable: Record<string, string>;
}

type Row = Streamer & { clip_count?: number };

/** Where this streamer stands with the scheduler right now. */
function recordingStatus(s: Row, snap: SchedulerSnapshot | undefined, recordingIds: Set<number>): { label: string; tone: BadgeTone } {
  if (recordingIds.has(s.id)) return { label: "Recording", tone: "live" };
  if (!s.is_live) return { label: s.auto_record ? "Auto-record on" : "Auto-record off", tone: "neutral" };
  const q = snap?.queue.find((x) => x.streamerId === s.id);
  if (!q) return { label: s.auto_record ? "Live" : "Live, not recorded", tone: "neutral" };
  return {
    label: q.reason === "waiting_for_slot" ? "Queued" : q.reason === "retry_wait" ? "Retrying" : q.reason === "gave_up" ? "Recording failed" : "Not recorded",
    tone: q.reason === "gave_up" ? "danger" : "warn",
  };
}

function StreamerCard({ s, onChanged, snap, recordingIds }: { s: Row; onChanged: () => void; snap: SchedulerSnapshot | undefined; recordingIds: Set<number> }) {
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
  const prio = useAction(async (priority: number) => {
    await client.patch(`/api/v1/streamers/${s.id}`, { priority });
    await sendRequest({ type: "capture/sync" }).catch(() => undefined);
    onChanged();
  });
  const fav = useAction(async () => {
    await client.patch(`/api/v1/streamers/${s.id}`, { is_favorite: !s.is_favorite });
    onChanged();
  });
  const remove = useAction(async () => {
    await client.delete(`/api/v1/streamers/${s.id}`);
    onChanged();
  });

  const status = recordingStatus(s, snap, recordingIds);
  const priority = snap?.priorities.find((p) => p.streamerId === s.id);
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <Avatar src={s.profile_image_url} name={s.display_name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-fg">{s.display_name}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <PlatformBadge platform={s.platform} />
            <LiveBadge isLive={s.is_live} />
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label={s.is_favorite ? `Remove ${s.display_name} from favourites` : `Mark ${s.display_name} as favourite`}
          aria-pressed={s.is_favorite}
          onClick={() => void fav.run()}
          icon={<Star className={cn("size-4", s.is_favorite && "fill-warn text-warn")} />}
        />
      </div>
      <div className="mt-3 min-h-8 text-xs text-fg-muted">
        <div className="truncate">{s.current_category ?? "No category"}</div>
        {s.current_title && <div className="truncate text-fg-subtle">{s.current_title}</div>}
        <div className="mt-1 text-[11px] text-fg-subtle">
          {s.status_checked_at ? `Status checked ${formatRelative(s.status_checked_at)}` : "Status not checked yet"}
          {s.is_live && s.viewer_count !== null ? ` · ${s.viewer_count.toLocaleString()} viewers` : ""}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-fg-subtle">
          <span>
            {s.clip_count ?? 0} clip{s.clip_count === 1 ? "" : "s"}
          </span>
          {priority && <span title={priority.explain.join("\n")}>Priority score {priority.total}</span>}
          {s.record_error && <span className="text-danger">Last failure: {s.record_error}</span>}
        </div>
      </div>
      <label className="mt-3 flex items-center justify-between gap-2 text-xs text-fg-muted">
        Your priority
        <Select aria-label={`Priority for ${s.display_name}`} className="!w-36" value={String(s.priority ?? 0)} onChange={(e) => void prio.run(Number(e.target.value))}>
          <option value="2">+2 Highest</option>
          <option value="1">+1 Higher</option>
          <option value="0">0 Normal</option>
          <option value="-1">−1 Lower</option>
          <option value="-2">−2 Lowest</option>
        </Select>
      </label>
      {(toggle.error || remove.error || autoRecord.error || prio.error || fav.error) && (
        <p className="mt-2 text-xs text-danger">{toggle.error ?? remove.error ?? autoRecord.error ?? prio.error ?? fav.error}</p>
      )}
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

/** Add a channel by name, link, @handle or channel ID; the platform is read from the link. */
function AddChannel({ onAdded }: { onAdded: () => void }) {
  const client = useApiClient();
  const [input, setInput] = useState("");
  const [platform, setPlatform] = useState<Platform>("twitch");
  const [notice, setNotice] = useState<string | null>(null);
  const raw = input.trim();
  const fromLink = channelFromUrl(/^https?:\/\//.test(raw) ? raw : raw.includes(".") ? `https://${raw}` : null);
  const effective = fromLink?.platform ?? platform;
  const add = useAction(async (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    if (!raw) throw new Error("Enter a channel name or link.");
    const s = await client.post<Streamer>("/api/v1/streamers", { platform: effective, username: raw });
    setNotice(`Added ${s.display_name} (${PLATFORM_LABEL[s.platform]}).`);
    setInput("");
    await sendRequest({ type: "capture/sync" }).catch(() => undefined);
    onAdded();
  });
  return (
    <form onSubmit={(e) => void add.run(e)} className="mb-5 flex flex-wrap items-start gap-2" aria-label="Add a channel">
      <Select aria-label="Platform" className="!w-32" value={effective} disabled={Boolean(fromLink)} onChange={(e) => setPlatform(e.target.value as Platform)}>
        {PLATFORMS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
      <div className="min-w-64 flex-1">
        <Input aria-label="Channel name or link" placeholder="Channel name, link, @handle or YouTube channel ID" value={input} onChange={(e) => setInput(e.target.value)} />
        {add.error ? <p className="mt-1 text-xs text-danger">{add.error}</p> : notice ? <p className="mt-1 text-xs text-live">{notice}</p> : null}
      </div>
      <Button type="submit" size="md" variant="primary" loading={add.pending} icon={<Plus className="size-4" />}>
        Add
      </Button>
    </form>
  );
}

export function StreamersPage({ onDiscover }: { onDiscover: () => void }) {
  const query = useApiQuery<Page<Row>>("/api/v1/streamers?limit=500");
  const snap = useStorageValue<SchedulerSnapshot>("sh.scheduler");
  const { slots } = useCaptures();
  const recordingIds = new Set(slots.filter((x) => x.recording && x.streamerId !== null).map((x) => x.streamerId!));
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
      <AddChannel onAdded={query.reload} />
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
              Add Twitch, Kick or YouTube channels to start monitoring them.
            </EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {page.items.map((s) => (
                <StreamerCard key={s.id} s={s} onChanged={query.reload} snap={snap} recordingIds={recordingIds} />
              ))}
            </div>
          )
        }
      </ApiStateView>
    </>
  );
}
