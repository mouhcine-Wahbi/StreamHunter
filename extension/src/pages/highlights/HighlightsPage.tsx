import { useMemo, useState } from "react";
import { ChevronDown, Sparkles, Trophy } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { HighlightRow } from "@/components/highlights/HighlightRow";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { DetectionType, LocalClip } from "@/local/clips";
import type { HighlightCandidate, Page, Platform } from "@/types/api";
import { ClipGrid } from "@/pages/clips/ClipsPage";
import { DETECTION_LABEL } from "@/pages/clips/ClipCard";

type Sort = "score" | "recent";
type Duration = "all" | "short" | "medium" | "long";

/** Moments found from chat or viewers while nothing was recorded: no video, kept for reference. */
function ProvisionalMoments() {
  const [open, setOpen] = useState(false);
  const query = useApiQuery<Page<HighlightCandidate>>(open ? "/api/v1/highlights?limit=50&has_video=false" : null);
  return (
    <Card className="mt-6">
      <CardHeader
        icon={<Sparkles className="size-4" />}
        title="Provisional moments (no video)"
        description="Found from chat or viewer numbers while the stream wasn't being recorded, or from a single signal. There is no clip for these."
        actions={
          <button type="button" className="inline-flex items-center gap-1 text-xs text-accent" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Show"} <ChevronDown className={`size-3.5 transition ${open ? "rotate-180" : ""}`} />
          </button>
        }
      />
      {open && (
        <CardBody className="pt-0">
          <ApiStateView query={query} feature="provisional moments" compact>
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState compact icon={<Sparkles className="size-4" />} title="None" />
              ) : (
                <div className="divide-y divide-ink-700/70">
                  {page.items.map((h) => (
                    <HighlightRow key={h.id} h={h} onChanged={query.reload} />
                  ))}
                </div>
              )
            }
          </ApiStateView>
        </CardBody>
      )}
    </Card>
  );
}

/** Top Highlights: every recorded clip, ranked by score, with filters. */
export function HighlightsPage() {
  const [sort, setSort] = useState<Sort>("score");
  const [streamer, setStreamer] = useState("all");
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [category, setCategory] = useState("all");
  const [duration, setDuration] = useState<Duration>("all");
  const [type, setType] = useState<DetectionType | "all">("all");

  // All clips once, for the filter choices.
  const all = useApiQuery<Page<LocalClip>>("/api/v1/clips?limit=500");
  const streamers = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of all.data?.items ?? []) m.set(c.streamer_id, c.streamer_display_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all.data]);
  const categories = useMemo(() => [...new Set((all.data?.items ?? []).map((c) => c.category).filter((c): c is string => Boolean(c)))].sort(), [all.data]);

  const path = useMemo(() => {
    const p = new URLSearchParams({ limit: "200" });
    if (sort === "score") p.set("sort", "score");
    if (streamer !== "all") p.set("streamer_id", streamer);
    if (platform !== "all") p.set("platform", platform);
    if (category !== "all") p.set("category", category);
    if (duration !== "all") p.set("duration", duration);
    if (type !== "all") p.set("type", type);
    return `/api/v1/clips?${p.toString()}`;
  }, [sort, streamer, platform, category, duration, type]);
  const query = useApiQuery<Page<LocalClip>>(path);
  const reload = () => {
    query.reload();
    all.reload();
  };

  return (
    <>
      <PageHeader
        title="Top Highlights"
        description="Recorded clips, ranked by their highlight score. Each score combines the signals that fired together: audio, chat, picture and viewers."
      />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filters">
        <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-40">
          <option value="score">Highest score</option>
          <option value="recent">Most recent</option>
        </Select>
        <Select aria-label="Streamer" value={streamer} onChange={(e) => setStreamer(e.target.value)} className="w-44">
          <option value="all">All streamers</option>
          {streamers.map(([id, name]) => (
            <option key={id} value={String(id)}>
              {name}
            </option>
          ))}
        </Select>
        <Select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value as Platform | "all")} className="w-36">
          <option value="all">All platforms</option>
          <option value="twitch">Twitch</option>
          <option value="kick">Kick</option>
        </Select>
        <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-44">
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Select aria-label="Duration" value={duration} onChange={(e) => setDuration(e.target.value as Duration)} className="w-40">
          <option value="all">Any length</option>
          <option value="short">Under 30 s</option>
          <option value="medium">30–60 s</option>
          <option value="long">Over 60 s</option>
        </Select>
        <Select aria-label="Detection type" value={type} onChange={(e) => setType(e.target.value as DetectionType | "all")} className="w-44">
          <option value="all">Any detection</option>
          {(Object.keys(DETECTION_LABEL) as DetectionType[]).map((t) => (
            <option key={t} value={t}>
              {DETECTION_LABEL[t]}
            </option>
          ))}
        </Select>
      </div>
      <ApiStateView query={query} feature="clips">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState icon={<Trophy className="size-5" />} title={all.data?.total ? "No clips match these filters" : "No clips yet"}>
              Clips appear here once StreamHunter records a monitored streamer and several signals fire together.
            </EmptyState>
          ) : (
            <ClipGrid items={page.items} onChanged={reload} ranked={sort === "score"} />
          )
        }
      </ApiStateView>
      <ProvisionalMoments />
    </>
  );
}
