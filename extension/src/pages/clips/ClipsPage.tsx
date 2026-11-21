import { useEffect, useMemo, useState } from "react";
import { Clapperboard } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { ApiStateView } from "@/components/ApiStateView";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { LocalClip } from "@/local/clips";
import type { Asset } from "@/local/assets";
import type { Page, Streamer } from "@/types/api";
import { ClipCard } from "./ClipCard";
import { LibraryItem } from "./LibraryItem";
import { applyFilters, libraryStatus, NO_FILTERS, STATUS_LABEL, type LibraryClip, type LibraryFilters } from "./library";

export function ClipGrid({ items, onChanged, ranked = false }: { items: LocalClip[]; onChanged: () => void; ranked?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {items.map((c, i) => (
        <ClipCard key={c.id} c={c} onChanged={onChanged} rank={ranked ? i + 1 : undefined} />
      ))}
    </div>
  );
}

export function ClipsPage() {
  const [sort, setSort] = useState<"recent" | "score" | "oldest">("recent");
  const [show, setShow] = useState<"all" | "favorites">("all");
  const [platform, setPlatform] = useState<"all" | "twitch" | "kick" | "youtube">("all");
  const [f, setF] = useState<LibraryFilters>(NO_FILTERS);
  const [tick, setTick] = useState(0);
  const query = useApiQuery<Page<LibraryClip>>(
    `/api/v1/clips?limit=500${sort !== "recent" ? `&sort=${sort}` : ""}${show === "favorites" ? "&favorite=true" : ""}${platform !== "all" ? `&platform=${platform}` : ""}&_=${tick}`,
  );
  const assetsQ = useApiQuery<Asset[]>(`/api/v1/assets?_=${tick}`);
  const streamersQ = useApiQuery<Page<Streamer>>("/api/v1/streamers?limit=500");
  const byClip = useMemo(() => {
    const m = new Map<number, Asset[]>();
    for (const a of assetsQ.data ?? []) m.set(a.clip_id, [...(m.get(a.clip_id) ?? []), a]);
    return m;
  }, [assetsQ.data]);
  const assetsOf = (id: number) => byClip.get(id) ?? [];
  const streamers = useMemo(() => new Map((streamersQ.data?.items ?? []).map((s) => [s.id, s])), [streamersQ.data]);
  const all = query.data?.items ?? [];
  const creators = useMemo(() => [...new Set(all.map((c) => c.streamer_display_name))].sort((a, b) => a.localeCompare(b)), [all]);
  const generating = all.some((c) => libraryStatus(c, assetsOf(c.id)).status === "generating");
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(() => setTick((x) => x + 1), 2500);
    return () => clearInterval(t);
  }, [generating]);
  const reload = () => setTick((x) => x + 1);
  const set = <K extends keyof LibraryFilters>(k: K, v: LibraryFilters[K]) => setF((x) => ({ ...x, [k]: v }));
  const filtered = JSON.stringify(f) !== JSON.stringify(NO_FILTERS);
  return (
    <>
      <PageHeader
        title="Clip Library"
        description="Every clip StreamHunter made, stored in this browser. Preview each version, copy the title, description and hashtags for each platform, download the MP4 and upload it yourself."
        actions={
          <>
            <Select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as "all" | "favorites")} className="w-36">
              <option value="all">All clips</option>
              <option value="favorites">Favourites</option>
            </Select>
            <Select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)} className="w-36">
              <option value="all">All platforms</option>
              <option value="twitch">Twitch</option>
              <option value="kick">Kick</option>
              <option value="youtube">YouTube</option>
            </Select>
            <Select aria-label="Sort clips" value={sort} onChange={(e) => setSort(e.target.value as "recent" | "score" | "oldest")} className="w-36">
              <option value="recent">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="score">Highest score</option>
            </Select>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-2 text-xs" role="group" aria-label="Filters">
        <label className="space-y-0.5">
          <span className="block text-fg-subtle">Creator</span>
          <Select aria-label="Creator" value={f.creator} onChange={(e) => set("creator", e.target.value)} className="w-40">
            <option value="">All creators</option>
            {creators.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-0.5">
          <span className="block text-fg-subtle">Format</span>
          <Select aria-label="Format" value={f.format} onChange={(e) => set("format", e.target.value as LibraryFilters["format"])} className="w-52">
            <option value="all">Any format</option>
            <option value="vertical">Vertical 9:16 ready (Shorts, TikTok)</option>
            <option value="landscape">Landscape ready (X)</option>
          </Select>
        </label>
        <label className="space-y-0.5">
          <span className="block text-fg-subtle">Minimum score</span>
          <Input aria-label="Minimum score" type="number" min={0} max={100} value={f.minScore || ""} placeholder="0" onChange={(e) => set("minScore", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="w-24" />
        </label>
        <label className="space-y-0.5">
          <span className="block text-fg-subtle">Detected from</span>
          <Input aria-label="Detected from" type="date" value={f.from} onChange={(e) => set("from", e.target.value)} className="w-40" />
        </label>
        <label className="space-y-0.5">
          <span className="block text-fg-subtle">to</span>
          <Input aria-label="Detected to" type="date" value={f.to} onChange={(e) => set("to", e.target.value)} className="w-40" />
        </label>
        <label className="space-y-0.5">
          <span className="block text-fg-subtle">Status</span>
          <Select aria-label="Status" value={f.status} onChange={(e) => set("status", e.target.value as LibraryFilters["status"])} className="w-36">
            <option value="all">Any status</option>
            {(["generating", "ready", "failed"] as const).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </label>
        {filtered && (
          <Button size="sm" variant="ghost" onClick={() => setF(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
      </div>
      <ApiStateView query={query} feature="clips">
        {(page) => {
          if (page.items.length === 0)
            return (
              <EmptyState icon={<Clapperboard className="size-5" />} title={show === "favorites" ? "No favourites yet" : "No clips yet"}>
                Turn on Ask to record for a streamer, arm a recorder tab and start monitoring, then approve the recording when the streamer goes live. Detected moments become
                clips here.
              </EmptyState>
            );
          const items = applyFilters(page.items, assetsOf, f);
          return (
            <div className="space-y-3">
              <p className="text-xs text-fg-muted" aria-live="polite">
                {items.length === page.items.length ? `${items.length} clip${items.length === 1 ? "" : "s"}` : `${items.length} of ${page.items.length} clips match the filters`}
              </p>
              {items.map((c) => (
                <LibraryItem key={c.id} clip={c} assets={assetsOf(c.id)} streamer={streamers.get(c.streamer_id)} onChanged={reload} />
              ))}
            </div>
          );
        }}
      </ApiStateView>
    </>
  );
}
