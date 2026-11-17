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

export function ClipsPage() {
  const [sort, setSort] = useState<"recent" | "score">("score");
  const query = useApiQuery<Page<LocalClip>>(`/api/v1/clips?limit=100${sort === "score" ? "&sort=score" : ""}`);
  return (
    <>
      <PageHeader
        title="Clip Library"
        description="Real MP4 clips cut from streams you captured, stored in this browser. Download them to edit or post them yourself."
        actions={
          <Select aria-label="Sort clips" value={sort} onChange={(e) => setSort(e.target.value as "recent" | "score")} className="w-36">
            <option value="score">Top score</option>
            <option value="recent">Most recent</option>
          </Select>
        }
      />
      <ApiStateView query={query} feature="clips">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState icon={<Clapperboard className="size-5" />} title="No clips yet">
              Open a stream, click the StreamHunter icon and choose Capture this stream. Detected moments and "Save last 30 s" become clips here.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {page.items.map((c) => (
                <ClipCard key={c.id} c={c} onChanged={query.reload} />
              ))}
            </div>
          )
        }
      </ApiStateView>
    </>
  );
}
