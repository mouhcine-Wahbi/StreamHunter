import { useEffect, useState, type FormEvent } from "react";
import { Clapperboard, ExternalLink, FileVideo, Pencil, Send } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Field";
import { CANDIDATE_STATUS_META } from "@/components/highlights/HighlightRow";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useClipRequest } from "@/components/clips/useClipRequest";
import { useAction } from "@/hooks/useAction";
import { useApiClient } from "@/hooks/useApiQuery";
import type { Clip } from "@/types/api";
import { formatDateTime } from "@/utils/format";

function isHttps(u: string | null): u is string {
  if (!u) return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

const SOURCE_LABEL: Record<Clip["source"], string> = {
  auto: "captured automatically at detection",
  editor: "requested from review",
  manual: "made manually on the platform",
};

export function ClipCard({ c, onChanged }: { c: Clip; onChanged: () => void }) {
  const client = useApiClient();
  const meta = CANDIDATE_STATUS_META[c.status];
  const [title, setTitle] = useState(c.title ?? "");
  const [editingTitle, setEditingTitle] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState("");
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const patch = useAction(async (body: Record<string, unknown>) => {
    await client.patch(`/api/v1/clips/${c.id}`, body);
    onChanged();
  });
  const publish = useAction(async () => {
    await client.post(`/api/v1/clips/${c.id}/publish`, { confirm: true, ...(publishedUrl.trim() ? { published_url: publishedUrl.trim() } : {}) });
    setConfirmPublish(false);
    onChanged();
  });
  const doExport = useAction(async () => {
    setExportMsg(null);
    try {
      await client.post(`/api/v1/clips/${c.id}/export`);
      onChanged();
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : "Export unavailable");
    }
  });
  const download = useAction(async () => {
    const blob = await client.blob(`/api/v1/clips/${c.id}/file`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = c.local_file_path ?? `clip_${c.id}.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
  // While exporting, keep refreshing until the job finishes (the status may stay
  // "exporting" across several refreshes, so this must be an interval, not a one-shot).
  useEffect(() => {
    if (c.status !== "exporting") return;
    const t = setInterval(onChanged, 2000);
    return () => clearInterval(t);
  }, [c.status, onChanged]);
  const clipReq = useClipRequest(onChanged);

  const canPublish = c.status === "created" || c.status === "ready" || c.status === "unsupported";
  const error = patch.error ?? publish.error ?? clipReq.error ?? download.error;

  function saveTitle(e: FormEvent) {
    e.preventDefault();
    void patch.run({ title }).then(() => setEditingTitle(false));
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-ink-700 text-fg-muted">
          <Clapperboard className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <form onSubmit={saveTitle} className="flex gap-2">
              <Input aria-label="Clip title" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} autoFocus />
              <Button size="sm" type="submit" loading={patch.pending}>
                Save
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-fg">{c.title ?? `Clip #${c.id}`}</span>
              <button type="button" aria-label="Edit title" onClick={() => setEditingTitle(true)} className="cursor-pointer text-fg-subtle hover:text-fg">
                <Pencil className="size-3.5" />
              </button>
              <PlatformBadge platform={c.platform} />
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </div>
          )}
          <div className="mt-0.5 text-xs text-fg-muted">
            {formatDateTime(c.created_at)} · {SOURCE_LABEL[c.source]}
            {c.duration_seconds !== null && ` · ${c.duration_seconds}s`}
            {c.request_lag_seconds !== null && ` · requested ${Math.round(c.request_lag_seconds)} s after the peak`}
            {c.published_at && ` · published ${formatDateTime(c.published_at)}`}
          </div>
          {c.error_message && <p className="mt-1 text-xs text-warn">{c.error_message}</p>}
        </div>
        <div className="w-36 shrink-0">
          <Select
            aria-label="Aspect ratio"
            className="h-8 text-xs"
            value={c.aspect_ratio ?? "9:16"}
            onChange={(e) => void patch.run({ aspect_ratio: e.target.value })}
          >
            <option value="9:16">9:16 Vertical</option>
            <option value="16:9">16:9 Landscape</option>
            <option value="1:1">1:1 Square</option>
          </Select>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3 text-xs">
        {isHttps(c.platform_clip_url) ? (
          <a href={c.platform_clip_url} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1 rounded-lg bg-ink-700 px-3 text-fg hover:bg-ink-600">
            <ExternalLink className="size-3" /> Platform clip
          </a>
        ) : (
          <Badge>No platform clip yet</Badge>
        )}
        {isHttps(c.edit_url) && (
          <a href={c.edit_url} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1 px-2 text-fg-muted hover:text-fg">
            <ExternalLink className="size-3" /> Edit on Twitch
          </a>
        )}
        {c.status === "exporting" ? (
          <Badge tone="accent">Exporting {c.aspect_ratio ?? ""} MP4…</Badge>
        ) : c.local_file_path ? (
          <>
            <Button size="sm" variant="primary" loading={download.pending} icon={<FileVideo className="size-3.5" />} onClick={() => void download.run()}>
              Download MP4
            </Button>
            <Button size="sm" variant="ghost" loading={doExport.pending} onClick={() => void doExport.run()}>
              Re-export
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" loading={doExport.pending} icon={<FileVideo className="size-3.5" />} onClick={() => void doExport.run()}>
            Export MP4
          </Button>
        )}
        {c.platform === "twitch" && (c.status === "approved" || c.status === "failed") && (
          <Button size="sm" variant="secondary" loading={clipReq.pending} onClick={() => void clipReq.request(c.id, c.status === "failed")}>
            {c.status === "failed" ? "Retry" : "Create Twitch clip"}
          </Button>
        )}
        <div className="ml-auto">
          {canPublish && !confirmPublish && (
            <Button size="sm" variant="secondary" icon={<Send className="size-3.5" />} onClick={() => setConfirmPublish(true)}>
              Mark as published
            </Button>
          )}
        </div>
      </div>

      {c.status === "unsupported" && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void patch.run({ platform_clip_url: manualUrl });
          }}
        >
          <Input aria-label="Clip URL" placeholder="https://kick.com/…/clips/…" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} />
          <Button size="sm" type="submit" disabled={!manualUrl.trim()} loading={patch.pending}>
            Save clip link
          </Button>
        </form>
      )}

      {confirmPublish && (
        <div role="alertdialog" aria-label="Confirm publishing" className="mt-3 rounded-lg border border-accent/30 bg-accent-soft p-3 text-xs">
          <p className="text-fg">
            Mark this clip as published? StreamHunter does not post anything itself; this records that <strong>you</strong> published it.
          </p>
          <Input className="mt-2" aria-label="Where it was published (optional)" placeholder="https://… (optional)" value={publishedUrl} onChange={(e) => setPublishedUrl(e.target.value)} />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" loading={publish.pending} onClick={() => void publish.run()}>
              Confirm: mark as published
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmPublish(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {clipReq.momentPassed && (
        <div role="alertdialog" aria-label="Moment has passed" className="mt-3 rounded-lg border border-warn/30 bg-warn-soft p-3 text-xs text-warn">
          <p>{clipReq.momentPassed}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void clipReq.request(c.id, c.status === "failed", true)}>
              Capture current broadcast
            </Button>
            <Button size="sm" variant="ghost" onClick={clipReq.dismissMomentPassed}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {exportMsg && <p className="mt-2 text-xs text-fg-muted">{exportMsg}</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </Card>
  );
}
