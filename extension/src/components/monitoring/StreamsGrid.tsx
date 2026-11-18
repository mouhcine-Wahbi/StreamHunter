import { Pause, Play, Square, Video, Volume2, VolumeX } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, Dot, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PlatformBadge } from "@/components/streamers/PlatformBadge";
import { useCaptures } from "@/hooks/useCapture";
import { useSettings } from "@/hooks/useSettings";
import type { CaptureState, PauseReason } from "@/types/capture";
import { formatRelative, formatSeconds } from "@/utils/format";

const PAUSE_LABEL: Record<PauseReason, string> = {
  you: "Paused by you",
  monitoring: "Monitoring paused",
  overload: "Paused: Mac overloaded",
  storage: "Paused: disk almost full",
};

function slotStatus(s: CaptureState): { tone: Extract<BadgeTone, "live" | "warn" | "danger" | "neutral" | "accent">; label: string } {
  if (s.status === "starting") return { tone: "accent", label: "Starting" };
  if (s.paused) return { tone: "warn", label: s.pauseReason ? PAUSE_LABEL[s.pauseReason] : "Paused" };
  if (s.recording) return { tone: s.health?.throttled || s.silentSeconds >= 20 ? "warn" : "live", label: "Recording" };
  return { tone: "accent", label: "Armed, waiting" };
}

/** One card per recording slot, each with its own Pause/Resume, Stop and sound controls. */
export function StreamsGrid() {
  const c = useCaptures();
  const { settings } = useSettings();
  const max = settings.recording.maxStreams;
  return (
    <Card>
      <CardHeader
        icon={<Video className="size-4" />}
        title={`Recording slots (${c.slots.length} of ${max})`}
        description="Each recorder tab records one streamer independently: its own buffer, detection and clips."
      />
      <CardBody>
        {c.slots.length === 0 ? (
          <EmptyState compact icon={<Video className="size-4" />} title="No recorder tab">
            Open twitch.tv or kick.com in a tab, click the StreamHunter icon and choose Use this tab as a recorder (or press Alt+Shift+R on that tab).
            {max > 1 ? ` You can arm up to ${max} tabs.` : ""}
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {c.slots.map((s) => {
              const st = slotStatus(s);
              const id = s.tabId!;
              return (
                <div key={id} className="rounded-xl border border-ink-700 bg-ink-850 p-3 text-xs" aria-label={`Recording slot ${s.channel ?? id}`}>
                  <div className="flex items-center gap-2">
                    {s.platform && <PlatformBadge platform={s.platform} />}
                    <span className="truncate text-sm font-medium text-fg">{s.channel ?? "No streamer"}</span>
                    <Badge tone={st.tone} icon={<Dot tone={st.tone} pulse={st.tone === "live"} />}>
                      {st.label}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-fg-muted">
                    {s.mode === "recorder" ? "Recorder tab" : "Captured tab"}
                    {s.recording
                      ? ` · ${s.bufferedSeconds} s buffered · ${s.health ? `${s.health.fps} fps${s.health.throttled ? " (half rate)" : ""}` : "…"}`
                      : s.waitingReason
                        ? ` · ${s.waitingReason}`
                        : ""}
                  </p>
                  {s.recording && s.silentSeconds >= 20 && <p className="text-warn">No sound for {s.silentSeconds} s. Is the player muted?</p>}
                  <p className="text-fg-subtle">
                    {s.clips} clip{s.clips === 1 ? "" : "s"} · recorded {formatSeconds(s.recordedSeconds)}
                    {s.lastDetection ? ` · last moment ${formatRelative(s.lastDetection.at)} (score ${s.lastDetection.score})` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {s.paused ? (
                      <Button size="sm" variant="secondary" disabled={c.busy} icon={<Play className="size-3.5" />} onClick={() => void c.pause(id, false)}>
                        Resume
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" disabled={c.busy || s.status !== "capturing"} icon={<Pause className="size-3.5" />} onClick={() => void c.pause(id, true)}>
                        Pause
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={c.busy} icon={<Square className="size-3.5" />} onClick={() => void c.stop(id)}>
                      Stop
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={c.busy}
                      aria-pressed={s.listening}
                      aria-label={s.listening ? `Mute ${s.channel ?? "this stream"}` : `Listen to ${s.channel ?? "this stream"}`}
                      icon={s.listening ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
                      onClick={() => void c.listen(id, !s.listening)}
                    >
                      {s.listening ? "Listening" : "Listen"}
                    </Button>
                  </div>
                  {s.message && <p className="mt-1.5 text-fg-subtle">{s.message}</p>}
                </div>
              );
            })}
          </div>
        )}
        {c.note && c.slots.length === 0 && <p className="mt-2 text-xs text-fg-muted">{c.note}</p>}
        {c.error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {c.error}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
