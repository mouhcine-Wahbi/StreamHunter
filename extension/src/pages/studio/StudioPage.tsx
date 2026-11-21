/**
 * Publishing Studio (3.0): your approval queue, every job with its reason and history, and
 * publishing any clip yourself. A job shows "Published" only after the platform confirmed it.
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, Send } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { useApiClient, useApiQuery } from "@/hooks/useApiQuery";
import { sendRequest } from "@/services/runtime";
import { JOB_LABEL, type JobState, type PublishJob } from "@/local/jobs";
import { DESTINATION_LABEL, DESTINATIONS, type Destination } from "@/local/rights";
import type { ContentClip } from "@/local/content";
import { TIER_LABEL } from "@/scoring/score";
import type { Page } from "@/types/api";
import { formatRelative } from "@/utils/format";

export const JOB_TONE: Record<JobState, BadgeTone> = {
  needs_approval: "accent",
  waiting: "neutral",
  blocked: "warn",
  queued: "neutral",
  uploading: "accent",
  confirming: "accent",
  published: "live",
  failed: "danger",
  cancelled: "neutral",
};

const GROUPS: { title: string; description: string; states: JobState[] }[] = [
  { title: "Needs your approval", description: "Medium potential, or high potential while automatic publishing is off.", states: ["needs_approval"] },
  { title: "In progress", description: "Uploading, or waiting for the platform to confirm.", states: ["queued", "uploading", "confirming"] },
  { title: "Needs attention", description: "Blocked by a check, or failed. The reason says what to fix.", states: ["blocked", "failed"] },
  { title: "Waiting", description: "Waiting for the file, the text, or tomorrow's daily limit.", states: ["waiting"] },
  { title: "Published", description: "Confirmed by the platform.", states: ["published"] },
];

function JobRow({ job, clip, onChanged }: { job: PublishJob; clip: ContentClip | undefined; onChanged: () => void }) {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (what: "approve" | "cancel" | "retry") => {
    setBusy(true);
    setErr(null);
    try {
      await client.post(`/api/v1/jobs/${job.id}/${what}`, {});
      if (what !== "cancel") await sendRequest({ type: "publish/run" }).catch(() => undefined);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  const name = clip?.title ?? `Clip ${job.clip_id}`;
  return (
    <li className="space-y-1 border-t border-border px-5 py-3 text-xs first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{name}</span>
        <span className="text-fg-subtle">→ {DESTINATION_LABEL[job.destination]}</span>
        <Badge tone={JOB_TONE[job.state]}>{job.state === "uploading" ? `Uploading ${Math.round(job.progress * 100)}%` : JOB_LABEL[job.state]}</Badge>
        {clip?.viral && (
          <span className="text-fg-subtle">
            {TIER_LABEL[clip.viral.tier]} · {clip.viral.total}/100
          </span>
        )}
        {job.auto && <span className="text-fg-subtle">· automatic</span>}
      </div>
      {job.reason && <p className={job.state === "failed" || job.state === "blocked" ? "text-warn" : "text-fg-muted"}>{job.reason}</p>}
      {job.state === "published" && (
        <p className="text-fg-muted">
          Published {formatRelative(job.published_at)}
          {job.url ? (
            <>
              {" · "}
              <a href={job.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                Open post <ExternalLink className="size-3" />
              </a>
            </>
          ) : (
            " · the platform gave no public link"
          )}
        </p>
      )}
      {err && <p className="text-danger">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {["needs_approval", "blocked", "waiting"].includes(job.state) && !job.approved && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void act("approve")}>
            Approve
          </Button>
        )}
        {["failed", "blocked", "waiting"].includes(job.state) && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void act("retry")}>
            Try again now
          </Button>
        )}
        {["needs_approval", "blocked", "waiting", "queued", "failed"].includes(job.state) && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("cancel")}>
            Cancel
          </Button>
        )}
        <details className="text-fg-subtle">
          <summary className="cursor-pointer">History ({job.history.length})</summary>
          <ol className="mt-1 space-y-0.5">
            {job.history.map((h, k) => (
              <li key={k}>
                {new Date(h.at).toLocaleString()} · {JOB_LABEL[h.state]}
                {h.note ? `: ${h.note}` : ""}
              </li>
            ))}
          </ol>
        </details>
      </div>
    </li>
  );
}

function PublishClip({ clips, jobs, onChanged }: { clips: ContentClip[]; jobs: PublishJob[]; onChanged: () => void }) {
  const client = useApiClient();
  const [clipId, setClipId] = useState<number | "">("");
  const [dests, setDests] = useState<Destination[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const taken = (d: Destination) => jobs.some((j) => j.clip_id === clipId && j.destination === d && !["failed", "cancelled"].includes(j.state));
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await client.post("/api/v1/jobs", { clipId, destinations: dests });
      await sendRequest({ type: "publish/run" }).catch(() => undefined);
      setMsg("Added. Every check still applies (rights, account, file, limits).");
      setDests([]);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not add");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader icon={<Send className="size-4" />} title="Publish a clip yourself" description="Counts as your approval, whatever its potential. Rights, accounts and daily limits are still checked." />
      <div className="flex flex-wrap items-center gap-3 px-5 pb-4 text-xs">
        <select aria-label="Clip to publish" value={clipId} onChange={(e) => setClipId(e.target.value ? Number(e.target.value) : "")} className="h-8 w-72 rounded-md border border-border bg-bg px-2 text-xs text-fg">
          <option value="">Choose a clip…</option>
          {clips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title ?? `Clip ${c.id}`} · {c.streamer_display_name}
              {c.viral ? ` · ${c.viral.total}/100` : ""}
            </option>
          ))}
        </select>
        {DESTINATIONS.map((d) => (
          <label key={d} className="flex items-center gap-1.5 text-fg">
            <input type="checkbox" disabled={clipId === "" || taken(d)} checked={dests.includes(d)} onChange={(e) => setDests((x) => (e.target.checked ? [...x, d] : x.filter((y) => y !== d)))} />
            {DESTINATION_LABEL[d]}
            {clipId !== "" && taken(d) && <span className="text-fg-subtle">(has a job)</span>}
          </label>
        ))}
        <Button size="sm" disabled={clipId === "" || dests.length === 0} loading={busy} onClick={() => void submit()}>
          Publish
        </Button>
        {msg && <p className="w-full text-fg-muted">{msg}</p>}
      </div>
    </Card>
  );
}

export function StudioPage() {
  const [tick, setTick] = useState(0);
  const jobs = useApiQuery<PublishJob[]>(`/api/v1/jobs?_=${tick}`);
  const clips = useApiQuery<Page<ContentClip>>(`/api/v1/clips?limit=200&_=${tick}`);
  const byClip = useMemo(() => new Map((clips.data?.items ?? []).map((c) => [c.id, c])), [clips.data]);
  const active = (jobs.data ?? []).some((j) => ["queued", "uploading", "confirming"].includes(j.state));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, [active]);
  const refresh = () => setTick((x) => x + 1);
  return (
    <>
      <PageHeader title="Publishing Studio" description="One job per clip and destination. A post counts as published only when the platform confirms it." />
      <div className="space-y-4">
        <PublishClip clips={clips.data?.items ?? []} jobs={jobs.data ?? []} onChanged={refresh} />
        <ApiStateView query={jobs} feature="publishing">
          {(list) =>
            list.length === 0 ? (
              <EmptyState icon={<CheckCircle2 className="size-5" />} title="No publishing jobs yet">
                With automatic publishing on, high- and medium-potential clips you have publishing rights for appear here. You can also publish any clip above.
              </EmptyState>
            ) : (
              <div className="space-y-4">
                {GROUPS.map((g) => {
                  const rows = list.filter((j) => g.states.includes(j.state));
                  if (!rows.length) return null;
                  return (
                    <Card key={g.title}>
                      <CardHeader title={`${g.title} (${rows.length})`} description={g.description} />
                      <ul>
                        {rows.map((j) => (
                          <JobRow key={j.id} job={j} clip={byClip.get(j.clip_id)} onChanged={refresh} />
                        ))}
                      </ul>
                    </Card>
                  );
                })}
              </div>
            )
          }
        </ApiStateView>
      </div>
    </>
  );
}
