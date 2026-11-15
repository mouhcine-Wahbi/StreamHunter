import { useEffect } from "react";
import { MessageSquare } from "lucide-react";
import { Badge, Dot } from "@/components/ui/Badge";
import { useApiQuery } from "@/hooks/useApiQuery";

interface Activity {
  chat_state: "connecting" | "connected" | "unavailable" | "not_monitored";
  chat_reason: string | null;
  messages_per_minute?: number;
  unique_chatters_per_minute?: number;
  baseline_messages_per_minute?: number;
  warming_up?: boolean;
  series?: number[];
  active_signals?: string[];
}

const STATE: Record<Activity["chat_state"], { label: string; tone: "live" | "warn" | "accent" | "neutral" }> = {
  connected: { label: "Chat connected", tone: "live" },
  connecting: { label: "Connecting to chat", tone: "accent" },
  unavailable: { label: "Chat unavailable", tone: "warn" },
  not_monitored: { label: "Not monitored", tone: "neutral" },
};

/** Live chat activity for one session: aggregates only, refreshed every 10 s. */
export function SessionActivity({ sessionId }: { sessionId: number }) {
  const q = useApiQuery<Activity>(`/api/v1/monitoring/${sessionId}/activity`);
  const { reload } = q;
  useEffect(() => {
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);
  const a = q.data;
  if (!a) return null;
  const meta = STATE[a.chat_state];
  const series = a.series ?? [];
  const max = Math.max(1, ...series);
  const receiving = a.chat_state === "connected" || a.chat_state === "connecting";
  return (
    <div className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-900/60 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={meta.tone} icon={<Dot tone={meta.tone === "accent" ? "accent" : meta.tone} pulse={a.chat_state === "connected"} />}>
          {meta.label}
        </Badge>
        {receiving && a.messages_per_minute !== undefined && (
          <span className="flex items-center gap-1 text-fg-muted tabular">
            <MessageSquare className="size-3" /> {a.messages_per_minute}/min · {a.unique_chatters_per_minute} chatters
            {a.baseline_messages_per_minute !== undefined && !a.warming_up && <> · normal {a.baseline_messages_per_minute}/min</>}
          </span>
        )}
        {receiving && a.warming_up && <span className="text-fg-subtle">learning this chat's normal activity…</span>}
        {(a.active_signals ?? []).map((s) => (
          <Badge key={s} tone="accent">
            {s.replace(/_/g, " ")}
          </Badge>
        ))}
      </div>
      {a.chat_reason && <p className="mt-1.5 text-xs text-warn">{a.chat_reason}</p>}
      {receiving && series.length > 0 && (
        <div className="mt-2 flex h-8 items-end gap-px" role="img" aria-label="Chat messages per 5 seconds, last 3 minutes">
          {series.map((v, i) => (
            <div key={i} className="flex-1 rounded-sm bg-accent/60" style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}
