import { useState } from "react";
import { ChevronDown, ExternalLink, EyeOff, FileVideo, Play, Telescope, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { RightsBadge, RightsForm } from "@/components/rights/RightsForm";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import { useStorageValue } from "@/hooks/useStorageValue";
import { useSettings } from "@/hooks/useSettings";
import { sendRequest } from "@/services/runtime";
import { addSource, type SourceFile } from "@/local/sources";
import { DISCOVERY_KEY, type Candidate, type DiscoveryRun, type DiscoveryVia } from "@/discovery/discovery";
import type { Page } from "@/types/api";
import { formatRelative } from "@/utils/format";

const VIA_LABEL: Record<DiscoveryVia, string> = { creator_uploads: "Your creators", trending: "Trending", keyword: "Keywords" };
const PROCESSING_LABEL: Record<Candidate["processing"], string> = {
  not_started: "Not processed (nothing downloaded)",
  source_added: "Authorized file added",
  analyzing: "Analyzing",
  analyzed: "Analyzed",
  failed: "Failed",
};

const fmtDuration = (s: number | null) => (s === null ? "" : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const n = (v: number | null) => (v === null ? null : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));

function CandidateCard({ c, onChanged }: { c: Candidate; onChanged: () => void }) {
  const client = useApiClient();
  const [why, setWhy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  return (
    <li className="flex gap-3 py-3">
      {c.thumbnail_url ? <img src={c.thumbnail_url} alt="" className="h-20 w-36 flex-none rounded-md object-cover" loading="lazy" /> : <div className="h-20 w-36 flex-none rounded-md bg-ink-800" />}
      <div className="min-w-0 flex-1 space-y-1 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <PlatformBadge platform={c.platform} />
          <span className="truncate text-sm font-medium text-fg">{c.title}</span>
        </div>
        <p className="text-fg-muted">
          {c.creator_name}
          {c.kind === "clip" ? " · Twitch clip" : ""}
          {c.duration_seconds !== null ? ` · ${fmtDuration(c.duration_seconds)}` : ""}
          {c.published_at ? ` · ${formatRelative(c.published_at)}` : ""}
          {c.views !== null ? ` · ${n(c.views)} views` : ""}
          {c.likes !== null ? ` · ${n(c.likes)} likes` : ""}
        </p>
        <p className="text-fg-subtle">{c.reasons.join(" · ")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="flex items-center gap-1 text-fg-muted" aria-expanded={why} onClick={() => setWhy(!why)}>
            Source popularity <span className="font-semibold text-fg tabular">{c.popularity.score}</span>
            <ChevronDown className={`size-3 transition ${why ? "rotate-180" : ""}`} />
          </button>
          <RightsBadge rights={c.rights} />
          <Badge tone="neutral">{PROCESSING_LABEL[c.processing]}</Badge>
        </div>
        {why && (
          <ul className="space-y-0.5 text-fg-subtle">
            {c.popularity.explain.map((e) => (
              <li key={e}>· {e}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-700 px-3 text-xs text-fg hover:bg-ink-600">
            <ExternalLink className="size-3.5" /> Open source
          </a>
          <Button size="sm" variant="secondary" icon={<FileVideo className="size-3.5" />} onClick={() => setAdding(!adding)}>
            Add authorized file…
          </Button>
          <Button size="sm" variant="ghost" icon={<EyeOff className="size-3.5" />} onClick={() => void client.patch(`/api/v1/candidates/${c.id}`, { dismissed: !c.dismissed }).then(onChanged)}>
            {c.dismissed ? "Restore" : "Dismiss"}
          </Button>
        </div>
        {adding && (
          <RightsForm
            minimum="analysis"
            initial={c.rights}
            submitLabel="Add file"
            onSubmit={async (r) => {
              if (!file) throw new Error("Choose the video file first.");
              await addSource(file, { candidate_id: c.id, creator_name: c.creator_name, platform: c.platform, original_url: c.url }, r);
              setAdding(false);
              onChanged();
            }}
          >
            <p className="text-fg-muted">
              StreamHunter doesn't download discovered videos. If you're allowed to use this one (your own, licensed, or with the creator's permission), add the file you
              obtained through an authorized route.
            </p>
            <input aria-label="Video file" type="file" accept="video/mp4,video/quicktime,video/webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </RightsForm>
        )}
      </div>
    </li>
  );
}

function SourcesCard({ refresh, onChanged }: { refresh: number; onChanged: () => void }) {
  const client = useApiClient();
  const sources = useApiQuery<Page<SourceFile>>(`/api/v1/sources?limit=100&_=${refresh}`);
  return (
    <Card>
      <CardHeader icon={<FileVideo className="size-4" />} title="Authorized files" description="Files you added with rights evidence. Only these can be analyzed and clipped." />
      <CardBody>
        <ApiStateView query={sources} feature="authorized files" compact>
          {(p) =>
            p.items.length === 0 ? (
              <p className="text-xs text-fg-subtle">None yet. Use "Add authorized file…" on a discovered video.</p>
            ) : (
              <ul className="divide-y divide-ink-700/70 text-xs">
                {p.items.map((s) => (
                  <li key={s.id} className="space-y-1 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">{s.name}</span>
                      <RightsBadge rights={s.rights} />
                      <Badge tone={s.analysis === "failed" ? "danger" : s.analysis === "analyzed" ? "live" : "neutral"}>
                        {s.analysis === "not_analyzed" ? "Not analyzed" : s.analysis === "analyzing" ? "Analyzing…" : s.analysis === "analyzed" ? `${s.moments.length} moments` : "Analysis failed"}
                      </Badge>
                      <span className="ml-auto text-fg-subtle">{(s.size_bytes / 1024 ** 2).toFixed(1)} MB</span>
                    </div>
                    <p className="text-fg-subtle">
                      {s.creator_name} · evidence: {s.rights.evidence} · added {formatRelative(s.added_at)}
                      {s.analysis_error ? ` · ${s.analysis_error}` : ""}
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" icon={<Play className="size-3.5" />} disabled={s.analysis === "analyzing"} onClick={() => void sendRequest({ type: "source/analyze", id: s.id }).finally(onChanged)}>
                        {s.analysis === "analyzed" ? "Analyze again" : "Find moments"}
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void client.delete(`/api/v1/sources/${s.id}`).then(onChanged)}>
                        Delete file
                      </Button>
                    </div>
                    {s.moments.length > 0 && (
                      <ul className="space-y-0.5 pl-2 text-fg-muted">
                        {s.moments.slice(0, 10).map((m) => (
                          <li key={m.at} className="flex flex-wrap items-center gap-2">
                            <span className="tabular">{fmtDuration(Math.round(m.at))}</span>
                            <span>score {m.score}</span>
                            <span className="text-fg-subtle">{m.reasons.join(" · ")}</span>
                            <Button size="sm" variant="ghost" disabled={s.rights.status === "analysis"} title={s.rights.status === "analysis" ? "Needs \"Authorized for processing\"" : undefined}
                              onClick={() => void sendRequest({ type: "source/clip", id: s.id, start: m.start, end: m.end }).finally(onChanged)}>
                              Make clip
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </ApiStateView>
      </CardBody>
    </Card>
  );
}

export function ContentDiscoveryPage() {
  const { settings } = useSettings();
  const last = useStorageValue<DiscoveryRun>(DISCOVERY_KEY);
  const [via, setVia] = useState<DiscoveryVia | "all">("all");
  const [showDismissed, setShowDismissed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = `/api/v1/candidates?limit=200${via === "all" ? "" : `&via=${via}`}${showDismissed ? "&include_dismissed=1" : ""}&_=${refresh}:${last?.at ?? ""}`;
  const list = useApiQuery<Page<Candidate>>(q);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await sendRequest({ type: "discovery/run" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discovery failed");
    } finally {
      setRunning(false);
      setRefresh((x) => x + 1);
    }
  };
  return (
    <>
      <PageHeader
        title="Content Discovery"
        description="New uploads from your YouTube creators, trending videos and keyword matches. Discovering a video never downloads it or grants rights to it."
        actions={
          <Button variant="primary" icon={<Telescope className="size-4" />} loading={running} onClick={() => void run()}>
            Run discovery now
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader
            icon={<Telescope className="size-4" />}
            title="Discovery queue"
            description="Source popularity describes the original video; a clip's own potential is scored after it's made."
            actions={<Segmented label="Source" value={via} onChange={setVia} options={[{ id: "all", label: "All" }, ...(Object.keys(VIA_LABEL) as DiscoveryVia[]).map((v) => ({ id: v, label: VIA_LABEL[v] }))]} />}
          />
          <CardBody>
            <label className="mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
              <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed
            </label>
            <ApiStateView query={list} feature="discovered videos">
              {(p) =>
                p.items.length === 0 ? (
                  <EmptyState icon={<Telescope className="size-5" />} title="Nothing discovered yet">
                    Click Run discovery now. Creator uploads and trending need your YouTube API key; Twitch trending and keywords need your Twitch app (Settings → Platforms).
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-ink-700/70">
                    {p.items.map((c) => (
                      <CandidateCard key={c.id} c={c} onChanged={() => setRefresh((x) => x + 1)} />
                    ))}
                  </ul>
                )
              }
            </ApiStateView>
          </CardBody>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Last run" description={settings.discovery.intervalHours > 0 ? `Runs every ${settings.discovery.intervalHours} h while Chrome is open.` : "Runs only when you click."} />
            <CardBody className="space-y-1 text-xs text-fg-muted">
              {error && <p className="text-danger">{error}</p>}
              {!last ? (
                <p>Not run yet.</p>
              ) : (
                <>
                  <p>
                    {formatRelative(last.at)}: {last.added} new, {last.updated} updated · {last.units} YouTube quota units
                  </p>
                  {Object.entries(last.problems).map(([k, v]) => (
                    <p key={k} className="text-warn">
                      {k}: {v}
                    </p>
                  ))}
                </>
              )}
              <p className="pt-1 text-fg-subtle">
                Filters: last {settings.discovery.maxAgeDays || "∞"} days{settings.discovery.minViews ? `, ≥ ${settings.discovery.minViews} views` : ""}
                {settings.discovery.language ? `, language ${settings.discovery.language}` : ""} · keywords: {settings.discovery.keywords.join(", ") || "none"} (Settings → Content discovery)
              </p>
            </CardBody>
          </Card>
          <SourcesCard refresh={refresh} onChanged={() => setRefresh((x) => x + 1)} />
        </div>
      </div>
    </>
  );
}
