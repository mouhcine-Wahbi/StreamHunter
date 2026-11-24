/**
 * One clip in the Clip Library: preview of every version, creator and source, when it was detected,
 * the viral-potential score with its reasons, each version as its own download, where it fits best,
 * and the title, description and hashtags per platform with copy buttons. You upload the files
 * yourself; nothing here posts anywhere.
 */
import { useState, type FormEvent } from "react";
import { Check, Copy, Download, ExternalLink, FileText, Pencil, RotateCcw, Scissors, Sparkles, Star, Trash2, X } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useAction } from "@/hooks/useAction";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import { stamp, type Transcript } from "@/local/transcripts";
import { assetBlob, assetThumbnail, type Asset, type AssetKind } from "@/local/assets";
import { EDIT_STATE_LABEL, EDIT_TERMINAL, type EditJob } from "@/local/edits";
import { decideEdit, TEMPLATE_LABEL } from "@/editing/rules";
import { useSettings } from "@/hooks/useSettings";
import { clipBlob, clipThumbnail } from "@/local/clips";
import { DESTINATION_LABEL, type Destination } from "@/local/rights";
import { factsOf, GENERATOR_LABEL } from "@/metadata/metadata";
import { recommendPlatforms } from "@/scoring/score";
import { sendRequest } from "@/services/runtime";
import { cn } from "@/utils/cn";
import type { Streamer } from "@/types/api";
import { formatBytes, formatDateTime, formatOffset } from "@/utils/format";
import { ScoreView } from "@/pages/formats/ContentPanel";
import { DETECTION_LABEL, ScoreWhy, useObjectUrl } from "./ClipCard";
import { allMetadataText, CLIP_TYPE_LABEL, clipType, DEST_FORMAT, detectedAt, hashtagText, KIND_LABEL, libraryStatus, STATUS_LABEL, versionFileName, type LibraryClip, type LibraryStatus } from "./library";

const STATUS_TONE: Record<LibraryStatus, BadgeTone> = { generating: "accent", ready: "live", failed: "danger" };
const ASSET_STATUS = { queued: "Waiting", processing: "Making…", ready: "Ready", failed: "Failed" } as const;
const DESTS: Destination[] = ["youtube", "tiktok", "x"];
const EDIT_ROUTE: Record<AssetKind, string> = { vertical: "#/shorts", landscape: "#/xclips", edited_vertical: "#/shorts" };

type Version = "original" | AssetKind;

function CopyButton({ text, label, what }: { text: string; label: string; what: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  };
  return (
    <Button size="sm" variant="secondary" aria-label={`${label} (${what})`} disabled={!text} icon={state === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} onClick={() => void copy()}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </Button>
  );
}

function VersionPreview({ clip, asset, version }: { clip: LibraryClip; asset: Asset | undefined; version: Version }) {
  const ready = version === "original" || asset?.status === "ready";
  const key = version === "original" ? clip.id * 10 : (asset?.id ?? 0) * 10 + 1;
  const video = useObjectUrl(() => (!ready ? Promise.resolve(undefined) : version === "original" ? clipBlob(clip.id) : assetBlob(asset!)), ready ? key : -key - 1);
  const thumb = useObjectUrl(() => (asset?.has_thumbnail ? assetThumbnail(asset.id) : clip.has_thumbnail ? clipThumbnail(clip.id) : Promise.resolve(undefined)), key + 5);
  const vertical = version === "vertical" || version === "edited_vertical";
  return (
    <div className={cn("overflow-hidden rounded-lg bg-black", vertical ? "mx-auto aspect-[9/16] h-72" : "aspect-video w-full")}>
      {video ? (
        <video src={video} poster={thumb ?? undefined} controls preload="metadata" className="size-full object-contain" aria-label={`Preview of ${clip.title ?? "clip"} (${version === "original" ? "original" : KIND_LABEL[version]})`} />
      ) : thumb ? (
        <img src={thumb} alt="" className="size-full object-cover opacity-50" />
      ) : (
        <div className="grid size-full place-items-center text-xs text-fg-subtle">Video missing</div>
      )}
    </div>
  );
}

function DownloadLink({ clip, version, asset }: { clip: LibraryClip; version: Version; asset?: Asset }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = versionFileName(clip, version);
  const label = version === "original" ? "Original" : KIND_LABEL[version];
  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      const blob = version === "original" ? await clipBlob(clip.id) : await assetBlob(asset!);
      if (!blob) throw new Error("The file is no longer stored.");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not download");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col">
      <Button size="sm" variant={version === "original" ? "secondary" : "primary"} loading={busy} icon={<Download className="size-3.5" />} aria-label={`Download ${label} MP4`} title={name} onClick={() => void download()}>
        {label}
      </Button>
      {err && <span className="text-[11px] text-danger">{err}</span>}
    </span>
  );
}

function MetadataTabs({ clip, assets, onChanged }: { clip: LibraryClip; assets: Asset[]; onChanged: () => void }) {
  const md = clip.metadata;
  const [dest, setDest] = useState<Destination>("youtube");
  const write = useAction(async () => {
    await sendRequest({ type: "metadata/generate", clipId: clip.id, resetEdits: false });
    onChanged();
  });
  if (!md)
    return (
      <div className="space-y-1 rounded-md border border-border p-2 text-xs text-fg-muted">
        <p>No title, description or hashtags yet. They're written when a version is ready, or now:</p>
        <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} loading={write.pending} onClick={() => void write.run()}>
          Write now
        </Button>
        {write.error && <p className="text-danger">{write.error}</p>}
      </div>
    );
  const meta = md.byDestination[dest];
  const kind = DEST_FORMAT[dest];
  const fileReady = assets.some((a) => a.kind === kind && a.status === "ready");
  const name = DESTINATION_LABEL[dest];
  return (
    <div className="space-y-2 rounded-md border border-border p-2 text-xs">
      <div role="tablist" aria-label="Text for" className="flex flex-wrap gap-1">
        {DESTS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === dest}
            onClick={() => setDest(d)}
            className={cn("rounded-md px-2 py-1", d === dest ? "bg-ink-700 font-medium text-fg" : "text-fg-muted hover:text-fg")}
          >
            {DESTINATION_LABEL[d]}
            {md.edited.includes(d) && " ·"}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={`${name} text`} className="space-y-2">
        <p className="text-fg-subtle">
          Upload the {KIND_LABEL[kind].toLowerCase()} file{fileReady ? "" : " (not made yet)"}. Written by {GENERATOR_LABEL[md.generator]}
          {md.edited.includes(dest) ? ", edited by you" : ""}.{" "}
          <a href={EDIT_ROUTE[kind]} className="text-accent underline">
            Edit text
          </a>
        </p>
        <dl className="space-y-1.5">
          {dest === "youtube" ? (
            <div>
              <dt className="text-fg-subtle">Title</dt>
              <dd className="text-fg">{meta.title || "—"}</dd>
            </div>
          ) : (
            <p className="text-fg-subtle">{name} has no separate title: paste the {dest === "x" ? "post" : "caption"}.</p>
          )}
          <div>
            <dt className="text-fg-subtle">{dest === "youtube" ? "Description" : dest === "tiktok" ? "Caption" : "Post"}</dt>
            <dd className="whitespace-pre-wrap text-fg">{meta.description || "—"}</dd>
          </div>
          <div>
            <dt className="text-fg-subtle">Hashtags</dt>
            <dd className="text-fg">{hashtagText(meta) || "—"}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-1.5">
          {dest === "youtube" && <CopyButton text={meta.title} label="Copy title" what={name} />}
          <CopyButton text={meta.description} label="Copy description" what={name} />
          <CopyButton text={hashtagText(meta)} label="Copy hashtags" what={name} />
          <CopyButton text={allMetadataText(dest, meta)} label="Copy all" what={name} />
        </div>
      </div>
    </div>
  );
}

export function LibraryItem({ clip, assets, edits = [], streamer, onChanged }: { clip: LibraryClip; assets: Asset[]; edits?: EditJob[]; streamer?: Pick<Streamer, "username" | "platform">; onChanged: () => void }) {
  const client = useApiClient();
  const vertical = assets.find((a) => a.kind === "vertical");
  const landscape = assets.find((a) => a.kind === "landscape");
  const edited = assets.find((a) => a.kind === "edited_vertical" && a.status === "ready");
  const versions: Version[] = ["original", ...(["edited_vertical", "vertical", "landscape"] as const).filter((k) => assets.some((a) => a.kind === k && a.status === "ready"))];
  const [version, setVersion] = useState<Version>("original");
  const shown: Version = versions.includes(version) ? version : "original";
  const { status, detail } = libraryStatus(clip, assets);
  const [title, setTitle] = useState(clip.title ?? "");
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [why, setWhy] = useState(false);
  const source = factsOf(clip, streamer).originalUrl;
  const recs = clip.viral ? recommendPlatforms(clip.viral, { vertical: vertical?.status === "ready", landscape: landscape?.status === "ready" }) : [];

  const rename = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await client.patch(`/api/v1/clips/${clip.id}`, { title });
    setEditing(false);
    onChanged();
  });
  const favorite = useAction(async () => {
    await client.patch(`/api/v1/clips/${clip.id}`, { favorite: !clip.favorite });
    onChanged();
  });
  const remove = useAction(async () => {
    await client.delete(`/api/v1/clips/${clip.id}`);
    onChanged();
  });

  return (
    <Card role="article" className="grid gap-4 p-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" aria-label={`Clip: ${clip.title ?? clip.id}`}>
      <div className="space-y-2">
        <VersionPreview key={shown} clip={clip} asset={shown === "original" ? undefined : shown === "vertical" ? vertical : shown === "edited_vertical" ? edited : landscape} version={shown} />
        {versions.length > 1 && (
          <div role="group" aria-label="Preview version" className="flex flex-wrap gap-1 text-xs">
            {versions.map((v) => (
              <button key={v} type="button" aria-pressed={v === shown} onClick={() => setVersion(v)} className={cn("rounded-md px-2 py-1", v === shown ? "bg-ink-700 font-medium text-fg" : "text-fg-muted hover:text-fg")}>
                {v === "original" ? "Original" : KIND_LABEL[v]}
              </button>
            ))}
          </div>
        )}
        <div className="space-y-1 text-xs">
          <div className="font-medium text-fg">Downloads</div>
          <div className="flex flex-wrap gap-1.5">
            <DownloadLink clip={clip} version="original" />
            {edited && <DownloadLink clip={clip} version="edited_vertical" asset={edited} />}
            {vertical?.status === "ready" && <DownloadLink clip={clip} version="vertical" asset={vertical} />}
            {landscape?.status === "ready" && <DownloadLink clip={clip} version="landscape" asset={landscape} />}
          </div>
          <ul className="space-y-0.5 text-[11px] text-fg-subtle" aria-label="Formats">
            <li>
              Original · {clip.width ?? "?"}×{clip.height ?? "?"} · {clip.duration_seconds ?? "?"} s · {formatBytes(clip.size_bytes)}
            </li>
            {edited && (
              <li>
                {KIND_LABEL.edited_vertical} · {edited.width}×{edited.height} · {edited.duration_seconds} s · {formatBytes(edited.size_bytes)} · {TEMPLATE_LABEL[edited.template ?? ""] ?? edited.template}
              </li>
            )}
            {(["vertical", "landscape"] as const).map((k) => {
              const a = k === "vertical" ? vertical : landscape;
              return (
                <li key={k}>
                  {KIND_LABEL[k]} ·{" "}
                  {!a ? (
                    "not made"
                  ) : (
                    <span className={cn(a.status === "failed" && "text-danger")}>
                      {ASSET_STATUS[a.status]}
                      {a.status === "ready" && a.width ? ` · ${a.width}×${a.height}${a.reused_original ? " (same file as the original)" : ` · ${formatBytes(a.size_bytes)}`}` : ""}
                      {a.status === "processing" ? ` ${Math.round(a.progress * 100)}%` : ""}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {editing ? (
              <form onSubmit={(e) => void rename.run(e)} className="flex gap-2">
                <Input aria-label="Clip title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
                <Button size="sm" type="submit" loading={rename.pending}>
                  Save
                </Button>
              </form>
            ) : (
              <h3 className="text-sm font-medium text-fg">{clip.title}</h3>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
              <span className="font-medium text-fg">{clip.streamer_display_name}</span>
              {["twitch", "kick", "youtube"].includes(clip.platform) && <PlatformBadge platform={clip.platform} />}
              <Badge tone="neutral">{CLIP_TYPE_LABEL[clipType(clip)]}</Badge>
              {clip.category && <span>{clip.category}</span>}
              {source && (
                <a href={source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline">
                  Source <ExternalLink className="size-3" />
                </a>
              )}
              {clip.platform_clip_url && (
                <a href={clip.platform_clip_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline">
                  Twitch clip <ExternalLink className="size-3" />
                </a>
              )}
              {clip.source_id ? <span>· from your file</span> : null}
            </div>
          </div>
          <span role="status" aria-label={`Status: ${STATUS_LABEL[status]}`}>
            <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={clip.favorite ? "Remove from favourites" : "Mark as favourite"}
            aria-pressed={clip.favorite}
            loading={favorite.pending}
            onClick={() => void favorite.run()}
            icon={<Star className={cn("size-4", clip.favorite && "fill-warn text-warn")} />}
          />
        </div>
        {detail && <p className={cn("text-xs", status === "failed" ? "text-danger" : "text-fg-muted")}>{detail}</p>}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-fg-subtle">Detected</dt>
          <dd className="tabular text-fg">
            {formatDateTime(detectedAt(clip))}
            {clip.stream_offset_sec !== null && <span className="text-fg-muted"> · {formatOffset(clip.stream_offset_sec)} into the stream</span>}
            {clip.source_offset_sec !== undefined && <span className="text-fg-muted"> · {formatOffset(clip.source_offset_sec)} into the file</span>}
          </dd>
          <dt className="text-fg-subtle">Found by</dt>
          <dd className="flex flex-wrap gap-1">
            {clip.detection_types.map((t) => (
              <Badge key={t} tone={t === "manual" ? "neutral" : "accent"}>
                {DETECTION_LABEL[t]}
              </Badge>
            ))}
            {clip.reasons.slice(0, 2).map((r) => (
              <span key={r} className="text-fg-muted">
                · {r}
              </span>
            ))}
          </dd>
          <dt className="text-fg-subtle">Best for</dt>
          <dd className="text-fg" aria-label="Platform recommendation">
            {recs.length ? (
              <>
                <span className="font-medium">{DESTINATION_LABEL[recs[0]!.dest]}</span>
                <span className="text-fg-muted">
                  {" "}
                  (fit {recs[0]!.points}/100: {recs[0]!.inputs.join(", ")})
                  {recs.slice(1).map((r) => ` · ${DESTINATION_LABEL[r.dest]} ${r.points}`)}
                </span>
              </>
            ) : clip.viral ? (
              <span className="text-fg-muted">Make a vertical or landscape version to get a recommendation.</span>
            ) : (
              <span className="text-fg-muted">Not scored yet.</span>
            )}
          </dd>
        </dl>

        <div className="text-xs">
          {clip.viral ? (
            <ScoreView score={clip.viral} />
          ) : (
            <p className="text-fg-muted">
              Detection score {clip.score}. The viral-potential score is added when a version is ready.{" "}
              <button type="button" className="text-accent underline" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
                {why ? "Hide why" : "Why this score?"}
              </button>
            </p>
          )}
          {why && <ScoreWhy c={clip} />}
        </div>

        <EditPanel clip={clip} edits={edits} edited={edited} onChanged={onChanged} />

        <TranscriptPanel clip={clip} />

        <MetadataTabs clip={clip} assets={assets} onChanged={onChanged} />

        <div className="flex flex-wrap gap-1.5">
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
            <Button size="sm" variant="ghost" aria-label="Delete clip" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </div>
        {(rename.error || remove.error || favorite.error) && <p className="text-xs text-danger">{rename.error ?? remove.error ?? favorite.error}</p>}
      </div>
    </Card>
  );
}

/**
 * 4.0 editing: the automatic edit (score ≥ "edit automatically"), an Edit button in the review band,
 * progress with Cancel, and Retry. The edited Short is a separate version; the original is unchanged.
 */
function EditPanel({ clip, edits, edited, onChanged }: { clip: LibraryClip; edits: EditJob[]; edited: Asset | undefined; onChanged: () => void }) {
  const { settings } = useSettings();
  const s = settings.editing;
  const job = edits[0];
  const score = clip.viral?.total ?? null;
  const decision = decideEdit(score, s);
  const start = useAction(async () => {
    await sendRequest({ type: "edit/start", clipId: clip.id });
    onChanged();
  });
  const cancel = useAction(async () => {
    if (job) await sendRequest({ type: "edit/cancel", id: job.id });
    onChanged();
  });
  const retry = useAction(async () => {
    if (job) await sendRequest({ type: "edit/retry", id: job.id });
    onChanged();
  });
  const running = job && !EDIT_TERMINAL.includes(job.state);
  const error = start.error ?? cancel.error ?? retry.error;
  let line: React.ReactNode;
  if (running) {
    line = (
      <>
        <span role="status" aria-label={`Edit: ${job.step}`}>
          {job.step}
          {(job.state === "encoding" || job.state === "rendering" || job.state === "transcribing") ? ` ${Math.round(job.progress * 100)}%` : "…"}
        </span>
        <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} loading={cancel.pending} onClick={() => void cancel.run()}>
          Cancel edit
        </Button>
      </>
    );
  } else if (job?.state === "failed" || job?.state === "cancelled") {
    line = (
      <>
        <span role="status" aria-label={`Edit: ${EDIT_STATE_LABEL[job.state]}`} className={job.state === "failed" ? "text-danger" : "text-fg-muted"}>
          Edit {job.state === "failed" ? `failed: ${job.error ?? "unknown error"}` : "cancelled"}
        </span>
        <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} loading={retry.pending} onClick={() => void retry.run()}>
          Retry edit
        </Button>
      </>
    );
  } else if (edited) {
    const m = edited.metrics;
    line = (
      <span role="status" aria-label="Edit: Ready" className="text-fg-muted">
        Edited Short ready ({job?.trigger === "manual" ? "you asked for it" : `edited automatically at score ${job?.score ?? score}`}).
        {m && ` Took ${(m.wall_ms / 1000).toFixed(1)} s, ${(m.cpu_ms / 1000).toFixed(1)} s CPU, ${formatBytes(m.peak_rss_bytes)} memory (${m.encoder}).`}
        {edited.notes.length > 0 && ` ${edited.notes.join(" ")}`}
      </span>
    );
  } else if (!s.enabled) {
    line = <span className="text-fg-subtle">Automatic editing is off (Settings → Editing).</span>;
  } else if (decision === "none") {
    line = <span className="text-fg-subtle">{score === null ? "Not scored yet; clips are edited from the viral-potential score." : `Not edited: score ${score} is below ${s.offerFrom}.`}</span>;
  } else {
    line = (
      <>
        <span className="text-fg-muted">
          {decision === "auto" ? `Score ${score} ≥ ${s.autoFrom}: edited automatically when the companion is connected.` : `Score ${score}: worth reviewing. Edit it into a vertical Short if you want.`}
        </span>
        <Button size="sm" variant="secondary" icon={<Scissors className="size-3.5" />} loading={start.pending} onClick={() => void start.run()}>
          Edit into a Short
        </Button>
      </>
    );
  }
  return (
    <div className="space-y-1 rounded-md border border-border p-2 text-xs" aria-label="Editing">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">Editing</span>
        {line}
      </div>
      {running && <div className="h-1 overflow-hidden rounded bg-ink-800"><div className="h-full bg-accent" style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}

/**
 * 4.4: what is said in the clip, transcribed on this computer by the companion (Whisper). Exact words
 * with their times; text Whisper produced over sound with no speech is dropped and counted.
 */
function TranscriptPanel({ clip }: { clip: LibraryClip }) {
  const q = useApiQuery<Transcript | null>(`/api/v1/clips/${clip.id}/transcript`);
  const [open, setOpen] = useState(false);
  const run = useAction(async () => {
    await sendRequest({ type: "transcript/start", clipId: clip.id });
    q.reload();
    setOpen(true);
  });
  const t = q.data;
  return (
    <div className="space-y-1 rounded-md border border-border p-2 text-xs" aria-label="Transcript">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">Transcript</span>
        {t ? (
          <>
            <span className="text-fg-muted">
              {t.segments.length ? `${t.segments.length} line${t.segments.length === 1 ? "" : "s"}` : "No speech found"} · Whisper {t.model}
              {t.language ? ` · ${t.language}` : ""}
              {t.metrics ? ` · took ${(t.metrics.wall_ms / 1000).toFixed(1)} s` : ""}
              {t.dropped.length > 0 && ` · ${t.dropped.length} piece${t.dropped.length === 1 ? "" : "s"} dropped (no speech in the sound)`}
            </span>
            {t.segments.length > 0 && (
              <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                {open ? "Hide" : "Show"}
              </Button>
            )}
            {t.segments.length > 0 && <CopyButton text={t.segments.map((x) => `[${stamp(x.start)}] ${x.text}`).join("\n")} label="Copy transcript" what="transcript" />}
          </>
        ) : (
          <>
            <span className="text-fg-subtle">Not transcribed. Needs the companion with Whisper; runs on this computer.</span>
            <Button size="sm" variant="secondary" icon={<FileText className="size-3.5" />} loading={run.pending} onClick={() => void run.run()}>
              {run.pending ? "Transcribing…" : "Transcribe"}
            </Button>
          </>
        )}
      </div>
      {open && t && (
        <ol className="max-h-48 space-y-0.5 overflow-auto" aria-label="Transcript lines">
          {t.segments.map((x) => (
            <li key={x.start} className="flex gap-2">
              <span className="w-10 shrink-0 tabular-nums text-fg-subtle">{stamp(x.start)}</span>
              <span className="text-fg">{x.text}</span>
            </li>
          ))}
        </ol>
      )}
      {run.error && <p className="text-danger">{run.error}</p>}
    </div>
  );
}
