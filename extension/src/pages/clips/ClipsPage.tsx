import { Clapperboard, ExternalLink, FileVideo } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { CANDIDATE_STATUS_META } from "@/components/highlights/HighlightRow";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useApiQuery } from "@/hooks/useApiQuery";
import type { Clip, Page } from "@/types/api";
import { formatDateTime } from "@/utils/format";

function isSafeHttpUrl(u: string): boolean {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

export function ClipsPage() {
  const query = useApiQuery<Page<Clip>>("/api/v1/clips?limit=50");
  return (
    <>
      <PageHeader
        title="Clip Library"
        description="A platform clip link is not a downloadable file. Each clip shows exactly what exists."
      />
      <Card>
        <CardBody className="pt-2">
          <ApiStateView query={query} feature="clips">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState icon={<Clapperboard className="size-5" />} title="No clips yet">
                  Approve a highlight to request an official platform clip where the platform supports it.
                </EmptyState>
              ) : (
                <ul className="divide-y divide-ink-700/70">
                  {page.items.map((c) => {
                    const meta = CANDIDATE_STATUS_META[c.status];
                    return (
                      <li key={c.id} className="flex flex-wrap items-center gap-3 py-3.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-fg">{c.title ?? `Clip #${c.id}`}</span>
                            <PlatformBadge platform={c.platform} />
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </div>
                          <div className="mt-0.5 text-xs text-fg-muted">
                            {formatDateTime(c.created_at)}
                            {c.duration_seconds !== null && ` · ${c.duration_seconds}s`}
                            {c.aspect_ratio && ` · ${c.aspect_ratio}`}
                          </div>
                          {c.error_message && <div className="mt-1 text-xs text-danger">{c.error_message}</div>}
                        </div>
                        <div className="flex gap-2 text-xs">
                          {c.platform_clip_url && isSafeHttpUrl(c.platform_clip_url) ? (
                            <a
                              href={c.platform_clip_url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 rounded-md bg-ink-700 px-2 py-1 text-fg hover:bg-ink-600"
                            >
                              <ExternalLink className="size-3" /> Platform clip
                            </a>
                          ) : (
                            <Badge>No platform clip</Badge>
                          )}
                          {c.local_file_path ? (
                            <Badge tone="live" icon={<FileVideo className="size-3" />}>
                              Exported file
                            </Badge>
                          ) : (
                            <Badge>No local file</Badge>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )
            }
          </ApiStateView>
        </CardBody>
      </Card>
    </>
  );
}
