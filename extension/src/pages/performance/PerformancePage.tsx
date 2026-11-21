/**
 * Performance (3.0): numbers the platforms report for your published clips. Nothing is estimated;
 * a missing number shows as "—" with the reason.
 */
import { BarChart3, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { PublishJob } from "@/local/jobs";
import { DESTINATION_LABEL, DESTINATIONS } from "@/local/rights";
import type { ContentClip } from "@/local/content";
import type { Page } from "@/types/api";
import { formatRelative } from "@/utils/format";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString());
const sum = (rows: PublishJob[], k: "views" | "likes" | "comments" | "shares") => {
  const vals = rows.map((r) => r.metrics?.[k]).filter((v): v is number => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};

export function PerformancePage() {
  const jobs = useApiQuery<PublishJob[]>("/api/v1/jobs?state=published");
  const clips = useApiQuery<Page<ContentClip>>("/api/v1/clips?limit=200");
  const title = (id: number) => clips.data?.items.find((c) => c.id === id)?.title ?? `Clip ${id}`;
  return (
    <>
      <PageHeader title="Performance" description="Views, likes, comments and shares as each platform reports them, read every 6 hours for 30 days after publishing. Nothing here is estimated." />
      <ApiStateView query={jobs} feature="performance">
        {(list) =>
          list.length === 0 ? (
            <EmptyState icon={<BarChart3 className="size-5" />} title="Nothing published yet">
              Numbers appear here once a platform has confirmed a post and reported its statistics.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {DESTINATIONS.map((d) => {
                  const rows = list.filter((j) => j.destination === d);
                  return (
                    <Card key={d} className="p-4 text-xs">
                      <div className="font-medium text-fg">{DESTINATION_LABEL[d]}</div>
                      <div className="mt-2 text-2xl font-semibold text-fg tabular">{n(sum(rows, "views"))}</div>
                      <div className="text-fg-subtle">
                        views · {rows.length} post{rows.length === 1 ? "" : "s"} · {n(sum(rows, "likes"))} likes
                      </div>
                    </Card>
                  );
                })}
              </div>
              <Card>
                <CardHeader title="Published clips" description="X views are impressions. TikTok gives numbers only for public posts that passed its moderation." />
                <table className="w-full text-left text-xs">
                  <thead className="text-fg-subtle">
                    <tr>
                      <th className="px-5 py-2 font-medium">Clip</th>
                      <th className="py-2 font-medium">Where</th>
                      <th className="py-2 text-right font-medium">Views</th>
                      <th className="py-2 text-right font-medium">Likes</th>
                      <th className="py-2 text-right font-medium">Comments</th>
                      <th className="py-2 text-right font-medium">Shares</th>
                      <th className="px-5 py-2 font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((j) => (
                      <tr key={j.id} className="border-t border-border text-fg">
                        <td className="px-5 py-2">
                          {j.url ? (
                            <a href={j.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                              {title(j.clip_id)} <ExternalLink className="size-3" />
                            </a>
                          ) : (
                            title(j.clip_id)
                          )}
                        </td>
                        <td className="py-2">{DESTINATION_LABEL[j.destination]}</td>
                        <td className="py-2 text-right tabular">{n(j.metrics?.views)}</td>
                        <td className="py-2 text-right tabular">{n(j.metrics?.likes)}</td>
                        <td className="py-2 text-right tabular">{n(j.metrics?.comments)}</td>
                        <td className="py-2 text-right tabular">{n(j.metrics?.shares)}</td>
                        <td className="px-5 py-2 text-fg-subtle">{j.metrics ? formatRelative(j.metrics.fetched_at) : "not reported yet"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          )
        }
      </ApiStateView>
    </>
  );
}
