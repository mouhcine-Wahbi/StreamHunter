import { useEffect, useState, type FormEvent } from "react";
import { Download, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";
import { ScoreRing } from "@/components/highlights/HighlightRow";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useAction } from "@/hooks/useAction";
import { useApiClient } from "@/hooks/useApiQuery";
import { clipBlob, clipFileName, type LocalClip } from "@/local/clips";
import { formatDateTime } from "@/utils/format";

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** One clip: a real MP4 cut from a capture, stored in this browser. Preview, rename, download, delete. */
export function ClipCard({ c, onChanged }: { c: LocalClip; onChanged: () => void }) {
  const client = useApiClient();
  const [url, setUrl] = useState<string | null>(null);
  const [title, setTitle] = useState(c.title ?? "");
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    void clipBlob(c.id).then((b) => {
      if (!alive || !b) return;
      objectUrl = URL.createObjectURL(b);
      setUrl(objectUrl);
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [c.id]);

  const rename = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await client.patch(`/api/v1/clips/${c.id}`, { title });
    setEditing(false);
    onChanged();
  });
  const remove = useAction(async () => {
    await client.delete(`/api/v1/clips/${c.id}`);
    onChanged();
  });

  return (
    <Card className="flex flex-col gap-4 p-4 md:flex-row">
      <div className="w-full shrink-0 overflow-hidden rounded-lg bg-black md:w-72">
        {url ? (
          <video src={url} controls preload="metadata" className="aspect-video w-full" aria-label={`Preview of ${c.title ?? "clip"}`} />
        ) : (
          <div className="grid aspect-video place-items-center text-xs text-fg-subtle">Video missing</div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ScoreRing score={c.score} size={34} />
          {editing ? (
            <form onSubmit={(e) => void rename.run(e)} className="flex flex-1 gap-2">
              <Input aria-label="Clip title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
              <Button size="sm" type="submit" loading={rename.pending}>
                Save
              </Button>
            </form>
          ) : (
            <>
              <span className="truncate font-medium text-fg">{c.title}</span>
              <Button size="sm" variant="ghost" aria-label="Rename clip" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)} />
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          <PlatformBadge platform={c.platform} />
          <Badge tone="live">MP4 ready</Badge>
          <span>
            {c.streamer_display_name} · {formatDateTime(c.started_at)} · {c.duration_seconds ?? "?"} s · {c.width}×{c.height} · {mb(c.size_bytes)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {url && (
            <a
              href={url}
              download={clipFileName(c)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white hover:opacity-90"
            >
              <Download className="size-3.5" /> Download MP4
            </a>
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
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </div>
        {(rename.error || remove.error) && <p className="text-xs text-danger">{rename.error ?? remove.error}</p>}
      </div>
    </Card>
  );
}
