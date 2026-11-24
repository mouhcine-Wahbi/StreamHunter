/**
 * 4.5 YouTube Video Clipper: search or paste a URL → the video's details → import its file →
 * analysis (loudness here, speech with Whisper in the companion) → candidate segments you approve
 * one by one → clips, edited into Shorts by the usual score rules. No rights step. StreamHunter
 * itself never downloads from YouTube; yt-dlp is a separate opt-in.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Download, ExternalLink, FileVideo, Trash2, Link2, Search, Scissors, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/EmptyState";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import { useAction } from "@/hooks/useAction";
import { sendRequest } from "@/services/runtime";
import { useSettings } from "@/hooks/useSettings";
import { durationMatch, importForVideo, type Segment } from "@/clipper/clipper";
import type { Candidate } from "@/discovery/discovery";
import type { SourceFile } from "@/local/sources";
import type { Page } from "@/types/api";
import { formatBytes, formatDateTime } from "@/utils/format";

const mmss = (s: number | null) => (s === null ? "—" : `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(Math.floor(s / 3600) ? 2 : 1, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`);

export function ClipperPage() {
  const client = useApiClient();
  const [refresh, setRefresh] = useState(0);
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [url, setUrl] = useState("");
  const mine = useApiQuery<Page<Candidate>>(`/api/v1/candidates?limit=200&platform=youtube&via=clipper&include_dismissed=1&_=${refresh}`);
  const search = useAction(async () => {
    const found = await client.post<Candidate[]>("/api/v1/clipper/search", { q });
    setResults(found);
    setRefresh((x) => x + 1);
  });
  const lookup = useAction(async () => {
    const [c] = await client.post<Candidate[]>("/api/v1/clipper/lookup", { url });
    setResults(null);
    setRefresh((x) => x + 1);
    if (c) setSelected(c.id);
  });
  const all = mine.data?.items ?? [];
  const current = all.find((c) => c.id === selected) ?? results?.find((c) => c.id === selected) ?? null;
  return (
    <>
      <PageHeader
        title="YouTube Video Clipper"
        description="Make Shorts from YouTube videos. Find the video, import its file, then approve the segments you want: each becomes a clip, edited into a Short by your Editing settings."
      />
      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader icon={<Search className="size-4" />} title="Find a video" description="Search uses your YouTube Data API key (100 quota units per search, about 100 searches a day). A pasted link costs 1 unit, or none without a key." />
            <CardBody className="space-y-3 text-xs">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (q.trim()) void search.run();
                }}
              >
                <Input aria-label="Search YouTube" className="w-full" placeholder="Search YouTube" value={q} onChange={(e) => setQ(e.target.value)} />
                <Button type="submit" size="sm" variant="secondary" loading={search.pending}>
                  Search
                </Button>
              </form>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (url.trim()) void lookup.run();
                }}
              >
                <Input aria-label="YouTube video URL" className="w-full" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} />
                <Button type="submit" size="sm" variant="secondary" icon={<Link2 className="size-3.5" />} loading={lookup.pending}>
                  Open
                </Button>
              </form>
              {(search.error || lookup.error) && <p className="text-danger">{search.error ?? lookup.error}</p>}
              {results && (
                <div>
                  <p className="mb-1 font-medium text-fg">Search results</p>
                  {results.length === 0 ? <p className="text-fg-subtle">No videos found.</p> : <VideoList items={results} selected={selected} onSelect={setSelected} />}
                </div>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Your Clipper videos" description="Videos you opened here, with your decision." />
            <CardBody className="text-xs">{all.length === 0 ? <p className="text-fg-subtle">None yet.</p> : <VideoList items={all} selected={selected} onSelect={setSelected} />}</CardBody>
          </Card>
        </div>
        {current ? (
          <VideoPanel key={current.id} c={current} onChanged={() => setRefresh((x) => x + 1)} />
        ) : (
          <EmptyState icon={<Scissors className="size-5" />} title="Choose a video">
            Search YouTube or paste a link, then pick the video to clip.
          </EmptyState>
        )}
      </div>
    </>
  );
}

function VideoList({ items, selected, onSelect }: { items: Candidate[]; selected: number | null; onSelect: (id: number) => void }) {
  return (
    <ul className="space-y-1" aria-label="Videos">
      {items.map((c) => (
        <li key={c.id}>
          <button type="button" onClick={() => onSelect(c.id)} aria-pressed={selected === c.id} className={`flex w-full gap-2 rounded-md p-1.5 text-left hover:bg-ink-800 ${selected === c.id ? "bg-ink-800" : ""}`}>
            {c.thumbnail_url ? <img src={c.thumbnail_url} alt="" className="h-12 w-20 shrink-0 rounded object-cover" /> : <span className="h-12 w-20 shrink-0 rounded bg-ink-800" />}
            <span className="min-w-0">
              <span className="line-clamp-2 text-fg">{c.title}</span>
              <span className="block text-fg-subtle">
                {c.creator_name || "Unknown channel"} · {mmss(c.duration_seconds)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function VideoPanel({ c, onChanged }: { c: Candidate; onChanged: () => void }) {
  return (
    <div className="space-y-4" aria-label={`Video: ${c.title}`}>
      <Card>
        <CardBody className="space-y-2 text-xs">
          <div className="flex gap-3">
            {c.thumbnail_url && <img src={c.thumbnail_url} alt="" className="h-24 w-40 shrink-0 rounded object-cover" />}
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-fg">{c.title}</p>
              <p className="text-fg-muted">
                {c.creator_name || "Unknown channel"} · {mmss(c.duration_seconds)}
                {c.published_at && ` · published ${formatDateTime(c.published_at)}`}
                {c.views !== null && ` · ${c.views.toLocaleString()} views`}
              </p>
              <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline">
                <ExternalLink className="size-3" /> {c.url}
              </a>
            </div>
          </div>
        </CardBody>
      </Card>
      <ImportCard c={c} onChanged={onChanged} />
    </div>
  );
}

function ImportCard({ c, onChanged }: { c: Candidate; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const sources = useApiQuery<Page<SourceFile>>(`/api/v1/sources?limit=100&_=${tick}`);
  const mine = (sources.data?.items ?? []).filter((s) => s.candidate_id === c.id);
  const busy = mine.some((s) => s.analysis === "queued" || s.analysis === "analyzing" || s.transcript_status === "running" || (s.pending_clips ?? []).length > 0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, [busy]);
  const [file, setFile] = useState<File | null>(null);
  const add = useAction(async () => {
    if (!file) throw new Error("Choose the video file first.");
    const s = await importForVideo(c.id, file);
    await sendRequest({ type: "source/analyze", id: s.id });
    setFile(null);
    setTick((x) => x + 1);
    onChanged();
  });
  return (
    <>
      <Card>
        <CardHeader icon={<FileVideo className="size-4" />} title="1. Import the video file" description="Choose the video's file (for your own videos: YouTube Studio → Content → ⋮ → Download). StreamHunter analyses it and proposes segments to clip." />
        <CardBody className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Video file" type="file" accept="video/mp4,video/quicktime" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button size="sm" variant="secondary" loading={add.pending} disabled={!file} onClick={() => void add.run()}>
              Import and analyse
            </Button>
          </div>
          {add.error && <p className="text-danger">{add.error}</p>}
          <FetchOption c={c} onDone={() => {
            setTick((x) => x + 1);
            onChanged();
          }} />
        </CardBody>
      </Card>
      {mine.map((s) => (
        <SourceCard key={s.id} c={c} s={s} tick={tick} onChanged={() => setTick((x) => x + 1)} />
      ))}
    </>
  );
}

/**
 * Delete the imported file (and its segments) to free storage. Clips already cut from it are kept:
 * they are separate files in the Clip Library. Not while it is being analysed, transcribed or cut.
 */
function SourceDelete({ s, onChanged }: { s: SourceFile; onChanged: () => void }) {
  const client = useApiClient();
  const [confirming, setConfirming] = useState(false);
  const del = useAction(async () => {
    await client.delete(`/api/v1/sources/${s.id}`);
    onChanged();
  });
  const busy = s.analysis === "queued" || s.analysis === "analyzing" || s.transcript_status === "running" || (s.pending_clips ?? []).length > 0;
  if (!confirming)
    return (
      <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={() => setConfirming(true)}>
        Delete source file ({formatBytes(s.size_bytes)})
      </Button>
    );
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm delete">
      <span className="text-fg-muted">Delete this file and its segments? Clips already made from it stay in the Clip Library.</span>
      <Button size="sm" variant="danger" loading={del.pending} onClick={() => void del.run()}>
        Delete
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep
      </Button>
      {del.error && <p className="text-danger">{del.error}</p>}
    </div>
  );
}

/**
 * 4.6: yt-dlp, only when turned on in Settings, and with your confirmation for this video that it
 * is your own or that you have written permission to download it. Hidden when the setting is off.
 */
function FetchOption({ c, onDone }: { c: Candidate; onDone: () => void }) {
  const { settings } = useSettings();
  const [basis, setBasis] = useState<"own" | "permission" | null>(null);
  const fetch = useAction(async () => {
    if (!basis) throw new Error("Confirm that you own this video or have written permission to download it.");
    await sendRequest({ type: "clipper/fetch", candidateId: c.id, basis });
    setBasis(null);
    onDone();
  });
  if (!settings.clipper.allowDownloadTool) return null;
  return (
    <div className="space-y-1.5 border-t border-ink-700/70 pt-2" aria-label="Download tool">
      <p className="text-fg-muted">Or fetch it with yt-dlp in the companion (no cookies or sign-in; private, members-only, paid, age-restricted, live and protected videos are refused).</p>
      <fieldset className="space-y-1">
        <legend className="sr-only">Download confirmation</legend>
        <label className="flex items-start gap-1.5">
          <input type="radio" name={`fetch-${c.id}`} checked={basis === "own"} onChange={() => setBasis("own")} className="mt-0.5" />
          <span>This is my own video and I may download it.</span>
        </label>
        <label className="flex items-start gap-1.5">
          <input type="radio" name={`fetch-${c.id}`} checked={basis === "permission"} onChange={() => setBasis("permission")} className="mt-0.5" />
          <span>I have written permission from the rights holder to download it.</span>
        </label>
      </fieldset>
      <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} loading={fetch.pending} disabled={!basis} onClick={() => void fetch.run()}>
        Fetch with yt-dlp
      </Button>
      {fetch.pending && <p className="text-fg-subtle">Checking and downloading… this can take a while for long videos.</p>}
      {fetch.error && <p className="text-danger">{fetch.error}</p>}
    </div>
  );
}

const ANALYSIS: Record<SourceFile["analysis"], string> = { not_analyzed: "Not analysed", queued: "Waiting to analyse…", analyzing: "Analysing the sound and picture…", analyzed: "Analysed", failed: "Analysis failed" };
const SPEECH: Record<NonNullable<SourceFile["transcript_status"]>, string> = { none: "Not transcribed", running: "Transcribing with Whisper (companion)…", done: "Transcribed", failed: "Transcription failed", unavailable: "No transcript" };
const SEG_LABEL: Record<Segment["status"], string> = { pending: "Waiting for you", approved: "Approved: cutting…", extracted: "Clip made", rejected: "Rejected", failed: "Failed" };

function SourceCard({ c, s, tick, onChanged }: { c: Candidate; s: SourceFile; tick: number; onChanged: () => void }) {
  const segs = useApiQuery<Segment[]>(`/api/v1/clipper/segments?source=${s.id}&_=${tick}`);
  const find = useAction(async () => {
    await sendRequest({ type: "clipper/segments", sourceId: s.id });
    onChanged();
  });
  const list = segs.data ?? [];
  // Once the analysis is done, look for segments once (with speech, if the companion is there).
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || s.analysis !== "analyzed" || s.transcript_status || !segs.data || segs.data.length > 0) return;
    auto.current = true;
    void find.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.analysis, s.transcript_status, segs.data]);
  // A segment being cut: refresh until it's a clip (or failed).
  const cutting = list.some((g) => g.status === "approved");
  useEffect(() => {
    if (!cutting) return;
    const t = setInterval(onChanged, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutting]);
  const match = durationMatch(c.duration_seconds, s.duration_seconds);
  const decide = async (id: number, approve: boolean) => {
    await sendRequest({ type: "clipper/segment", id, approve });
    onChanged();
  };
  return (
    <Card>
      <CardHeader icon={<Scissors className="size-4" />} title={`2. Segments of ${s.name}`} description="Proposed from what was measured: loud reactions and other signals, with the words said (Whisper). Approve the ones to cut; each becomes a clip, edited into a Short by your Editing settings." />
      <CardBody className="space-y-2 text-xs" aria-label={`Source ${s.name}`}>
        <p className="text-fg-muted" role="status" aria-label="Source status">
          {s.obtained_via === "yt-dlp" ? "Fetched with yt-dlp · " : ""}
          {ANALYSIS[s.analysis]}
          {s.duration_seconds !== null && ` · ${mmss(s.duration_seconds)}`} · {SPEECH[s.transcript_status ?? "none"]}
          {s.transcript?.dropped ? ` (${s.transcript.dropped} piece${s.transcript.dropped === 1 ? "" : "s"} of invented text dropped)` : ""}
        </p>
        {s.analysis_error && s.analysis === "failed" && <p className="text-danger">{s.analysis_error}</p>}
        {s.transcript_error && <p className="text-fg-subtle">{s.transcript_error}</p>}
        {match && <p className={match.ok ? "text-fg-muted" : "text-warn"}>{match.message}</p>}
        {find.error && <p className="text-danger">{find.error}</p>}
        <SourceDelete s={s} onChanged={onChanged} />
        {s.analysis === "analyzed" && (
          <Button size="sm" variant="ghost" loading={find.pending} onClick={() => void find.run()}>
            {list.length ? "Find segments again" : "Find segments"}
          </Button>
        )}
        {list.length > 0 && (
          <ul className="divide-y divide-ink-700/70" aria-label="Segments">
            {list.map((g) => (
              <li key={g.id} className="space-y-1 py-2" aria-label={`Segment ${mmss(g.start)}–${mmss(g.end)}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums text-fg">
                    {mmss(g.start)}–{mmss(g.end)}
                  </span>
                  <Badge tone="accent">score {Math.round(g.score)}</Badge>
                  <Badge tone={g.status === "extracted" ? "live" : g.status === "rejected" || g.status === "failed" ? "danger" : "neutral"}>{SEG_LABEL[g.status]}</Badge>
                  {(g.status === "pending" || g.status === "failed") && (
                    <>
                      <Button size="sm" variant="secondary" icon={<Check className="size-3.5" />} onClick={() => void decide(g.id, true)}>
                        {g.status === "failed" ? "Approve again" : "Approve segment"}
                      </Button>
                      <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => void decide(g.id, false)}>
                        Reject segment
                      </Button>
                    </>
                  )}
                  {g.status === "extracted" && (
                    <a className="text-accent underline" href="#/clips">
                      Open in Clip Library
                    </a>
                  )}
                </div>
                {g.status === "failed" && g.error && <p className="text-danger">{g.error}</p>}
                <ul className="text-fg-subtle">
                  {g.reasons.map((r) => (
                    <li key={r}>· {r}</li>
                  ))}
                </ul>
                {g.error && <p className="text-danger">{g.error}</p>}
              </li>
            ))}
          </ul>
        )}
        {s.analysis === "analyzed" && list.length === 0 && !find.pending && segs.data && <p className="text-fg-subtle">No segments: nothing stood out in the sound or picture.</p>}
      </CardBody>
    </Card>
  );
}
