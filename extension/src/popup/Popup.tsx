import { ExternalLink, PanelRight, Sparkles } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { MonitoringStatusPill, STATUS_META } from "@/components/monitoring/MonitoringStatusPill";
import { MonitoringToggle } from "@/components/monitoring/MonitoringToggle";
import { HighlightRow } from "@/components/highlights/HighlightRow";
import { ApiStateView } from "@/components/ApiStateView";
import { EmptyState } from "@/components/ui/EmptyState";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useMonitoring } from "@/hooks/useMonitoring";
import { sendRequest } from "@/services/runtime";
import type { HighlightCandidate, Page, Streamer } from "@/types/api";
import { formatRelative } from "@/utils/format";

async function openSidePanel() {
  // Must run directly in the click handler: sidePanel.open requires a user gesture.
  const win = await chrome.windows.getCurrent();
  if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
  window.close();
}

export function Popup() {
  const monitoring = useMonitoring();
  const live = useApiQuery<Page<Streamer>>("/api/v1/streams/live?limit=1");
  const recent = useApiQuery<Page<HighlightCandidate>>("/api/v1/highlights?limit=3");
  const { state, error } = monitoring;

  return (
    <div className="flex min-h-[480px] flex-col">
      <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
        <Logo compact />
        <MonitoringStatusPill status={state.status} />
      </header>

      <section className="space-y-3 px-4 py-4" aria-label="Monitoring">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-ink-700 bg-ink-850 p-3">
            <div className="text-[11px] text-fg-subtle">Live now</div>
            <div className="mt-1 text-xl font-semibold text-fg tabular">{live.data?.total ?? "—"}</div>
          </div>
          <div className="rounded-xl border border-ink-700 bg-ink-850 p-3">
            <div className="text-[11px] text-fg-subtle">Last heartbeat</div>
            <div className="mt-1 truncate text-sm font-medium text-fg">{formatRelative(state.lastSuccessAt)}</div>
          </div>
        </div>
        <p className="text-xs text-fg-muted">{STATUS_META[state.status].description}</p>
        {(error || state.lastError) && (
          <p role="alert" className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
            {error ?? state.lastError}
          </p>
        )}
        <MonitoringToggle monitoring={monitoring} size="lg" className="w-full" />
      </section>

      <section className="flex-1 border-t border-ink-700 px-4 py-3" aria-labelledby="recent-title">
        <h2 id="recent-title" className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
          <Sparkles className="size-3.5" /> Recent highlights
        </h2>
        <ApiStateView query={recent} feature="highlights" compact>
          {(page) =>
            page.items.length === 0 ? (
              <EmptyState compact icon={<Sparkles className="size-4" />} title="No highlights yet" />
            ) : (
              <div className="divide-y divide-ink-700/70">
                {page.items.map((h) => (
                  <HighlightRow key={h.id} h={h} compact />
                ))}
              </div>
            )
          }
        </ApiStateView>
      </section>

      <footer className="grid grid-cols-2 gap-2 border-t border-ink-700 p-3">
        <Button
          variant="secondary"
          size="sm"
          icon={<ExternalLink className="size-3.5" />}
          onClick={() => void sendRequest({ type: "app/open", route: "/overview" }).then(() => window.close())}
        >
          Open workspace
        </Button>
        <Button variant="ghost" size="sm" icon={<PanelRight className="size-3.5" />} onClick={() => void openSidePanel()}>
          Side panel
        </Button>
      </footer>
    </div>
  );
}
