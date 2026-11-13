import { ExternalLink, Sparkles } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { MonitoringStatusPill } from "@/components/monitoring/MonitoringStatusPill";
import { MonitoringToggle } from "@/components/monitoring/MonitoringToggle";
import { HighlightRow } from "@/components/highlights/HighlightRow";
import { ApiStateView } from "@/components/ApiStateView";
import { EmptyState } from "@/components/ui/EmptyState";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useMonitoring } from "@/hooks/useMonitoring";
import { useSettings } from "@/hooks/useSettings";
import { sendRequest } from "@/services/runtime";
import type { HighlightCandidate, Page } from "@/types/api";

/** Review feed that can sit next to a stream tab. */
export function SidePanel() {
  const monitoring = useMonitoring();
  const { settings, loaded } = useSettings();
  const feed = useApiQuery<Page<HighlightCandidate>>(
    loaded ? `/api/v1/highlights?limit=30&min_score=${settings.detection.minHighlightScore}` : null,
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
        <Logo compact />
        <MonitoringStatusPill status={monitoring.state.status} />
      </header>
      <div className="flex gap-2 border-b border-ink-700 px-4 py-3">
        <MonitoringToggle monitoring={monitoring} size="sm" className="flex-1" />
        <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => void sendRequest({ type: "app/open", route: "/highlights" })}>
          Workspace
        </Button>
      </div>
      <main className="flex-1 overflow-y-auto px-4 py-3">
        <h1 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
          <Sparkles className="size-3.5" /> Highlight feed
        </h1>
        <ApiStateView query={feed} feature="highlights" compact>
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState compact icon={<Sparkles className="size-4" />} title="Nothing to review yet">
                New moments appear here while monitoring is active.
              </EmptyState>
            ) : (
              <div className="divide-y divide-ink-700/70">
                {page.items.map((h) => (
                  <HighlightRow key={h.id} h={h} compact />
                ))}
              </div>
            )
          }
        </ApiStateView>
      </main>
    </div>
  );
}
