import { useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, FileVideo, Search, Sparkles, Upload } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useAction } from "@/hooks/useAction";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import type { MediaCapabilities, MediaJob, MediaSource, MonitoringSession, Page } from "@/types/api";

function safeVod(url: string | null | undefined): string | null {
  try {
    return url && new URL(url).protocol === "https:" && new URL(url).hostname.endsWith("twitch.tv") ? url : null;
  } catch {
    return null;
  }
}

function fmtDuration(sec: number | null): string {
  if (sec === null) return "—";
  const s = Math.round(sec);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const RESULT_LABELS: Record<string, string> = {
  audio_peaks: "audio peaks",
  scene_changes: "scene changes",
  candidates_enriched: "highlights enriched",
  candidates_created: "new highlights",
  candidates_merged: "merged",
};

/** Post-stream tools for one session: platform VOD link, user-provided recording, analysis. */
export function SessionMedia({ session, onVodFound }: { session: MonitoringSession; onVodFound: () => void }) {
  const client = useApiClient();
  const caps = useApiQuery<MediaCapabilities>("/api/v1/media/capabilities");
  const media = useApiQuery<Page<MediaSource>>(`/api/v1/media?session_id=${session.id}`);
  const fileRef = useRef<HTMLInputElement>(null);
  const [rights, setRights] = useState(false);
  const [offset, setOffset] = useState("0");
  const [job, setJob] = useState<MediaJob | null>(null);

  const findVod = useAction(async () => {
    await client.post(`/api/v1/monitoring/${session.id}/vod`);
    onVodFound();
  });
  const upload = useAction(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) throw new Error("Choose a recording first");
    const form = new FormData();
    form.append("file", file);
    form.append("rights_confirmed", String(rights));
    form.append("session_id", String(session.id));
    form.append("offset_in_stream_sec", String(Math.max(0, Number(offset) || 0)));
    await client.upload("/api/v1/media/upload", form);
    if (fileRef.current) fileRef.current.value = "";
    media.reload();
  });
  const analyze = useAction(async (mediaId: number) => {
    setJob(await client.post<MediaJob>(`/api/v1/media/${mediaId}/analyze`));
  });

  // Poll the running job.
  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed") return;
    const t = setTimeout(async () => {
      try {
        setJob(await client.get<MediaJob>(`/api/v1/media/jobs/${job.id}`));
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [job, client]);

  const vod = safeVod(session.vod_url);
  const error = findVod.error ?? upload.error ?? analyze.error;

  return (
    <div className="mt-2 w-full space-y-3 rounded-lg border border-ink-700 bg-ink-900/60 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">Recording</span>
        {vod ? (
          <a href={vod} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline">
            <ExternalLink className="size-3" /> Twitch VOD
          </a>
        ) : session.platform === "twitch" ? (
          <Button size="sm" variant="ghost" loading={findVod.pending} icon={<Search className="size-3.5" />} onClick={() => void findVod.run()}>
            Find Twitch VOD
          </Button>
        ) : (
          <span className="text-fg-subtle">Kick has no VOD API.</span>
        )}
      </div>

      {media.data && media.data.items.length > 0 && (
        <ul className="space-y-1.5">
          {media.data.items.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2">
              <FileVideo className="size-3.5 text-fg-subtle" />
              <span className="text-fg">{m.original_name}</span>
              <span className="text-fg-subtle tabular">
                {fmtDuration(m.duration_sec)}
                {m.offset_in_stream_sec > 0 && ` · starts ${fmtDuration(m.offset_in_stream_sec)} into the stream`}
              </span>
              <Button size="sm" variant="secondary" loading={analyze.pending} icon={<Sparkles className="size-3.5" />} onClick={() => void analyze.run(m.id)}>
                Analyze
              </Button>
            </li>
          ))}
        </ul>
      )}

      {job && (
        <div role="status" className="rounded-md bg-ink-800 px-2.5 py-2">
          <Badge tone={job.status === "succeeded" ? "live" : job.status === "failed" ? "danger" : "accent"}>
            analysis {job.status}
          </Badge>
          {job.status === "succeeded" && (
            <span className="ml-2 text-fg-muted">
              {Object.entries(RESULT_LABELS)
                .map(([k, label]) => `${job.result[k] ?? 0} ${label}`)
                .join(" · ")}
            </span>
          )}
          {job.error_message && <span className="ml-2 text-danger">{job.error_message}</span>}
        </div>
      )}

      {caps.data && !caps.data.ffmpeg_available ? (
        <p className="text-warn">FFmpeg is not installed on the backend, so recordings can't be analysed or exported.</p>
      ) : (
        <form
          aria-label="Attach a recording"
          className="space-y-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void upload.run();
          }}
        >
          <p className="text-fg-muted">
            Attach a recording you own (for example your downloaded VOD) to analyse audio and scene changes and to export clips.
            StreamHunter never downloads videos from Twitch or Kick.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" aria-label="Recording file" accept={caps.data?.supported_extensions.join(",")} className="text-fg-muted" />
            <label className="flex items-center gap-1.5 text-fg-muted">
              Starts at stream second
              <Input aria-label="Recording start offset" type="number" min={0} value={offset} onChange={(e) => setOffset(e.target.value)} className="h-8 w-24" />
            </label>
          </div>
          <label className="flex items-start gap-2 text-fg-muted">
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5" />
            I have the rights to process this recording.
          </label>
          <Button size="sm" type="submit" variant="primary" disabled={!rights} loading={upload.pending} icon={<Upload className="size-3.5" />}>
            Upload recording
          </Button>
          {caps.data && <p className="text-fg-subtle">Large files: put them in {caps.data.media_folder} on the backend machine and register them via the API.</p>}
        </form>
      )}
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}
