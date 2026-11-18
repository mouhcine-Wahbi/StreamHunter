import { useState } from "react";
import { Clapperboard } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Field";
import { ApiStateView } from "@/components/ApiStateView";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { LocalClip } from "@/local/clips";
import type { Page } from "@/types/api";
import { ClipCard } from "./ClipCard";

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
  const query = useApiQuery<Page<LocalClip>>(
    `/api/v1/clips?limit=500${sort !== "recent" ? `&sort=${sort}` : ""}${show === "favorites" ? "&favorite=true" : ""}${platform !== "all" ? `&platform=${platform}` : ""}`,
  );
  return (
    <>
      <PageHeader
        title="Clip Library"
        description="Every MP4 StreamHunter recorded, stored in this browser. Preview, favourite, rename and download them for your editor."
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
      <ApiStateView query={query} feature="clips">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState icon={<Clapperboard className="size-5" />} title={show === "favorites" ? "No favourites yet" : "No clips yet"}>
              Turn on Auto-record for a streamer, arm a recorder tab from the StreamHunter popup and start monitoring. Detected moments become
              clips here.
            </EmptyState>
          ) : (
            <ClipGrid items={page.items} onChanged={query.reload} />
          )
        }
      </ApiStateView>
    </>
  );
}
