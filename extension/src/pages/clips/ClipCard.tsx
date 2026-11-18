import { useEffect, useState, type FormEvent } from "react";
import { Download, ExternalLink, Pencil, Play, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";
import { ScoreRing } from "@/components/highlights/HighlightRow";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useAction } from "@/hooks/useAction";
import { useApiClient } from "@/hooks/useApiQuery";
import { clipBlob, clipFileName, clipThumbnail, type DetectionType, type LocalClip } from "@/local/clips";
import { cn } from "@/utils/cn";
import { formatBytes, formatDateTime, formatOffset, formatRelative } from "@/utils/format";

export const DETECTION_LABEL: Record<DetectionType, string> = {
  audio: "Audio",
  chat: "Chat",
  visual: "Visual",
  viewers: "Viewers",
  manual: "Saved by you",
};

const PART_LABEL = { audio: "Audio", chat: "Chat", visual: "Visual", viewers: "Viewers", multi: "Several signals together" } as const;

/** How a clip's score was put together (points per signal, from Settings → Automatic clipping). */
export function ScoreWhy({ c }: { c: LocalClip }) {
  const parts = c.score_parts;
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 p-2 text-[11px] text-fg-muted" aria-label="Why this score">
      {c.detection_types.includes("manual") ? (
        <p>Saved by you with Save last N s (fixed score 70).</p>
      ) : parts ? (
        <>
          <ul className="space-y-0.5">
            {(Object.keys(PART_LABEL) as (keyof typeof PART_LABEL)[])
              .filter((k) => parts[k] > 0)
              .map((k) => (
                <li key={k} className="flex justify-between">
                  <span>{PART_LABEL[k]}</span>
                  <span className="tabular text-fg">+{parts[k]}</span>
                </li>
              ))}
            <li className="flex justify-between border-t border-ink-700 pt-0.5 font-medium text-fg">
              <span>Score</span>
              <span className="tabular">{c.score}</span>
            </li>
          </ul>
          <p className="mt-1">
            Confidence {Math.round((c.confidence ?? 0) * 100)}% ({c.detection_types.length} independent signal{c.detection_types.length === 1 ? "" : "s"}) · event
            lasted {c.event_seconds ?? "?"} s. Each signal adds up to its points at full strength; stronger reactions against the stream's own normal score closer to the maximum.
          </p>
        </>
      ) : (
        <p>Score {c.score} from: {c.detection_types.join(", ") || "unknown"}. (Recorded before score breakdowns were stored.)</p>
      )}
    </div>
  );
}

function useObjectUrl(load: () => Promise<Blob | undefined>, key: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    void load().then((b) => {
      if (!alive || !b) return;
      objectUrl = URL.createObjectURL(b);
      setUrl(objectUrl);
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}

/**
 * One clip: a real MP4 cut from a recording, stored in this browser. Thumbnail and preview,
 * metadata (streamer, platform, category, time in the stream, duration, why it was clipped, score),
 * favourite, rename, download, delete.
 */
export function ClipCard({ c, onChanged, rank }: { c: LocalClip; onChanged: () => void; rank?: number }) {
  const client = useApiClient();
  const video = useObjectUrl(() => clipBlob(c.id), c.id);
  const thumb = useObjectUrl(() => (c.has_thumbnail ? clipThumbnail(c.id) : Promise.resolve(undefined)), c.id);
  const [playing, setPlaying] = useState(false);
  const [title, setTitle] = useState(c.title ?? "");
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [why, setWhy] = useState(false);

  const rename = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await client.patch(`/api/v1/clips/${c.id}`, { title });
    setEditing(false);
    onChanged();
  });
  const favorite = useAction(async () => {
    await client.patch(`/api/v1/clips/${c.id}`, { favorite: !c.favorite });
    onChanged();
  });
  const remove = useAction(async () => {
    await client.delete(`/api/v1/clips/${c.id}`);
    onChanged();
  });

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="relative aspect-video w-full bg-black">
        {playing && video ? (
          <video src={video} controls autoPlay className="size-full" aria-label={`Preview of ${c.title ?? "clip"}`} />
        ) : (
          <button
            type="button"
            className="group relative block size-full"
            onClick={() => setPlaying(true)}
            disabled={!video}
            aria-label={`Preview ${c.title ?? "clip"}`}
          >
            {thumb ? (
              <img src={thumb} alt="" className="size-full object-cover" />
            ) : (
              <span className="grid size-full place-items-center text-xs text-fg-subtle">{video ? "No thumbnail" : "Video missing"}</span>
            )}
            {video && (
              <span className="absolute inset-0 grid place-items-center bg-black/20 opacity-90 transition group-hover:bg-black/40">
                <span className="grid size-11 place-items-center rounded-full bg-black/60 text-white">
                  <Play className="size-5" />
                </span>
              </span>
            )}
          </button>
        )}
        {!playing && (
          <>
            <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular">
              {c.duration_seconds ?? "?"} s
            </span>
            {rank !== undefined && (
              <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular">#{rank}</span>
            )}
          </>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start gap-2">
          <ScoreRing score={c.score} size={34} />
          <div className="min-w-0 flex-1">
            {editing ? (
              <form onSubmit={(e) => void rename.run(e)} className="flex gap-2">
                <Input aria-label="Clip title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
                <Button size="sm" type="submit" loading={rename.pending}>
                  Save
                </Button>
              </form>
            ) : (
              <div className="line-clamp-2 text-sm font-medium text-fg" title={c.title ?? undefined}>
                {c.title}
              </div>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
              <span className="font-medium text-fg">{c.streamer_display_name}</span>
              <PlatformBadge platform={c.platform} />
              {c.category && <span className="truncate">{c.category}</span>}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label={c.favorite ? "Remove from favourites" : "Mark as favourite"}
            aria-pressed={c.favorite}
            loading={favorite.pending}
            onClick={() => void favorite.run()}
            icon={<Star className={cn("size-4", c.favorite && "fill-warn text-warn")} />}
          />
        </div>

        {c.reasons.length > 0 && (
          <ul className="space-y-0.5 text-xs text-fg-muted">
            {c.reasons.slice(0, 3).map((r) => (
              <li key={r} className="truncate">
                · {r}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-1">
          {c.detection_types.map((t) => (
            <Badge key={t} tone={t === "manual" ? "neutral" : "accent"}>
              {DETECTION_LABEL[t]}
            </Badge>
          ))}
          {c.platform_clip_url && (
            <a href={c.platform_clip_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent underline">
              Twitch clip <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-fg-subtle">
          <dt>Recorded</dt>
          <dd className="text-right tabular">{formatDateTime(c.started_at)}</dd>
          <dt>In the stream</dt>
          <dd className="text-right tabular">{formatOffset(c.stream_offset_sec)}</dd>
          <dt>Created</dt>
          <dd className="text-right tabular">{formatRelative(c.created_at)}</dd>
          <dt>File</dt>
          <dd className="text-right tabular">
            {c.width}×{c.height} · {formatBytes(c.size_bytes)}
          </dd>
        </dl>
        <button type="button" className="self-start text-[11px] text-accent underline" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
          {why ? "Hide why" : "Why this score?"}
        </button>
        {why && <ScoreWhy c={c} />}
        {c.error_message && <p className="text-[11px] text-warn">{c.error_message}</p>}

        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
          {video && (
            <a
              href={video}
              download={clipFileName(c)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white hover:opacity-90"
            >
              <Download className="size-3.5" /> Download MP4
            </a>
          )}
          {!editing && (
            <Button size="sm" variant="ghost" aria-label="Rename clip" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
              Rename
            </Button>
          )}
          {confirming ? (
            <>
              <Button size="sm" variant="danger" loading={remove.pending} onClick={() => void remove.run()}>
                Delete permanently
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" aria-label="Delete clip" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirming(true)} />
          )}
        </div>
        {(rename.error || remove.error || favorite.error) && <p className="text-xs text-danger">{rename.error ?? remove.error ?? favorite.error}</p>}
      </div>
    </Card>
  );
}

