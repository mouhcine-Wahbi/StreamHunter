import { Clapperboard } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { Clip, Page } from "@/types/api";
import { ClipCard } from "./ClipCard";

export function ClipsPage() {
  const query = useApiQuery<Page<Clip>>("/api/v1/clips?limit=50");
  return (
    <>
      <PageHeader
        title="Clip Library"
        description="A platform clip link is not a downloadable file. Each clip shows exactly what exists. Nothing is published unless you confirm it."
      />
      <ApiStateView query={query} feature="clips">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState icon={<Clapperboard className="size-5" />} title="No clips yet">
              Approve a highlight to prepare its clip. With auto-capture on, Twitch clips are requested as soon as a highlight is detected.
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
