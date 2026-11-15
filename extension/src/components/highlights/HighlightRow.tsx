import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import type { CandidateStatus, HighlightCandidate } from "@/types/api";
import { formatOffset, formatRelative } from "@/utils/format";
import { cn } from "@/utils/cn";

export const CANDIDATE_STATUS_META: Record<CandidateStatus, { label: string; tone: BadgeTone }> = {
  detected: { label: "Detected", tone: "accent" },
  pending_review: { label: "Pending review", tone: "accent" },
  approved: { label: "Approved", tone: "live" },
  rejected: { label: "Rejected", tone: "neutral" },
  creation_requested: { label: "Creating clip", tone: "accent" },
  created: { label: "Clip created", tone: "live" },
  exporting: { label: "Exporting", tone: "accent" },
  ready: { label: "Ready", tone: "live" },
  failed: { label: "Failed", tone: "danger" },
  published: { label: "Published", tone: "live" },
  unsupported: { label: "Manual action", tone: "warn" },
};

export function CATEGORY_LABEL(category: string): string {
  return category.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function ScoreRing({ score, size = 40 }: { score: number; size?: number }) {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  const color = s >= 80 ? "var(--color-live)" : s >= 60 ? "var(--color-accent)" : "var(--color-fg-subtle)";
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full text-xs font-semibold tabular"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${color} ${s * 3.6}deg, var(--color-ink-700) 0)`,
      }}
      aria-label={`Score ${s} of 100`}
      role="img"
    >
      <span className="grid size-[calc(100%-6px)] place-items-center rounded-full bg-ink-850 text-fg">{s}</span>
    </div>
  );
}

export function HighlightRow({ h, compact = false }: { h: HighlightCandidate; compact?: boolean }) {
  const meta = CANDIDATE_STATUS_META[h.status];
  return (
    <div className={cn("flex items-start gap-3", compact ? "py-2.5" : "py-3.5")}>
      <ScoreRing score={h.score} size={compact ? 34 : 42} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{h.streamer_display_name ?? `Streamer #${h.streamer_id}`}</span>
          <PlatformBadge platform={h.platform} />
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
        <div className="mt-0.5 text-xs text-fg-muted">
          {CATEGORY_LABEL(h.category)} · {formatRelative(h.timestamp)}
          {h.start_offset_sec !== null && <> · ≈{formatOffset(h.start_offset_sec)} into stream</>}
        </div>
        {!compact && (
          <div className="mt-1 text-[11px] text-fg-subtle tabular">
            Confidence {Math.round(h.confidence * 100)}% · signals: chat
            {h.signal_breakdown?.chat != null && ` ${Math.round(h.signal_breakdown.chat)}`}
            {h.signal_breakdown && h.signal_breakdown.audio == null && " · audio and video not analysed yet"}
            {h.start_offset_sec !== null && " · offsets approximate"}
          </div>
        )}
        {!compact && h.reasons.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {h.reasons.slice(0, 4).map((r) => (
              <li key={r} className="rounded-md bg-ink-700/70 px-1.5 py-0.5 text-[11px] text-fg-muted">
                {r}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
