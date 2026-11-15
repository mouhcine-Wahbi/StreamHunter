import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiStateView } from "@/components/ApiStateView";
import { HighlightRow } from "@/components/highlights/HighlightRow";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSettings } from "@/hooks/useSettings";
import type { CandidateStatus, HighlightCandidate, Page, Platform } from "@/types/api";

const STATUS_FILTERS: readonly { id: CandidateStatus | "all"; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "pending_review", label: "Pending review" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
];

export function HighlightsPage() {
  const { settings, loaded } = useSettings();
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [status, setStatus] = useState<CandidateStatus | "all">("all");

  const path = useMemo(() => {
    if (!loaded) return null;
    const p = new URLSearchParams({ limit: "50", min_score: String(settings.detection.minHighlightScore) });
    if (platform !== "all") p.set("platform", platform);
    if (status !== "all") p.set("status", status);
    return `/api/v1/highlights?${p.toString()}`;
  }, [loaded, platform, status, settings.detection.minHighlightScore]);

  const query = useApiQuery<Page<HighlightCandidate>>(path);

  return (
    <>
      <PageHeader
        title="Highlights"
        description={`Detected moments scoring at least ${settings.detection.minHighlightScore}. Nothing is published without your approval.`}
        actions={
          <>
            <Select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value as Platform | "all")} className="w-36">
              <option value="all">All platforms</option>
              <option value="twitch">Twitch</option>
              <option value="kick">Kick</option>
            </Select>
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as CandidateStatus | "all")} className="w-44">
              {STATUS_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </Select>
          </>
        }
      />
      <Card>
        <CardBody className="pt-2">
          <ApiStateView query={query} feature="highlights">
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState icon={<Sparkles className="size-5" />} title="No highlights match">
                  Candidates are created from chat activity while monitoring is active.
                </EmptyState>
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
      </Card>
    </>
  );
}
