import type { ReactNode } from "react";
import { Clapperboard, MessageSquare, Radar, ScanSearch, Video, Workflow } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, Dot, type BadgeTone } from "@/components/ui/Badge";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useCapture } from "@/hooks/useCapture";
import { useSettings } from "@/hooks/useSettings";
import { useStorageValue } from "@/hooks/useStorageValue";
import type { useMonitoring } from "@/hooks/useMonitoring";
import { ACTIVITY_KEY, type ChatActivity } from "@/background/chat-manager";
import { TWITCH_USER_KEY, type TwitchUser } from "@/platforms/twitch-user";
import type { Page, Streamer } from "@/types/api";
import type { CaptureState } from "@/types/capture";
import { formatBytes, formatRelative } from "@/utils/format";

export interface ClipStats {
  clips: number;
  favorites: number;
  clip_bytes: number;
  clip_seconds: number;
  recorded_seconds: number;
  storage_used_bytes: number | null;
  storage_quota_bytes: number | null;
}

type Tone = Extract<BadgeTone, "live" | "warn" | "danger" | "neutral" | "accent">;

interface Stage {
  icon: ReactNode;
  name: string;
  tone: Tone;
  state: string;
  detail: string;
}

const ARM_HINT = "Open a Twitch, Kick or YouTube tab, click the StreamHunter icon and choose Use this tab as a recorder.";

/**
 * Honest state of the video stage across all slots: never "recording" unless frames are being
 * encoded, and live streamers that nobody records are named.
 */
export function videoStage(slots: CaptureState[], liveAutoRecord: Streamer[], max = 1, note: string | null = null): Pick<Stage, "tone" | "state" | "detail"> {
  const active = slots.filter((s) => s.status === "capturing" || s.status === "starting");
  const recording = active.filter((s) => s.recording);
  const recordedIds = new Set(recording.map((s) => s.streamerId));
  const missed = liveAutoRecord.filter((s) => !recordedIds.has(s.id));
  const missedText = missed.length
    ? ` ${missed.map((s) => s.display_name).join(", ")} ${missed.length === 1 ? "is" : "are"} live but not recorded${active.length >= max ? ` (all ${max} recorder slot${max === 1 ? "" : "s"} in use)` : `. ${ARM_HINT}`}`
    : "";
  if (active.length === 0) {
    if (liveAutoRecord.length > 0)
      return {
        tone: "danger",
        state: "Inactive",
        detail: `${liveAutoRecord.map((s) => s.display_name).join(", ")} ${liveAutoRecord.length === 1 ? "is" : "are"} live and detected, but video capture is inactive. ${ARM_HINT}`,
      };
    return { tone: "neutral", state: "Off", detail: note ?? "No recorder tab. Only live status and chat are monitored; there is no video to clip." };
  }
  if (recording.length > 0) {
    const problems = recording.filter((s) => s.silentSeconds >= 20 || s.health?.throttled);
    const list = recording
      .map((s) => `${s.channel ?? "?"} (${s.bufferedSeconds} s buffered${s.health?.throttled ? ", half frame rate" : ""}${s.silentSeconds >= 20 ? ", no sound: player muted?" : ""})`)
      .join(", ");
    return {
      tone: problems.length ? "warn" : "live",
      state: recording.length === 1 ? "Recording" : `Recording ${recording.length}`,
      detail: `${recording.length === 1 ? (recording[0]!.mode === "recorder" ? "Recorder tab" : "Captured tab") : `${recording.length} of ${max} slots`}: ${list}.${missedText}`,
    };
  }
  const paused = active.find((s) => s.paused);
  if (paused) return { tone: "warn", state: "Paused", detail: `${active.length === 1 ? "The recorder tab is armed" : `${active.length} recorder tabs are armed`}; recording resumes with monitoring.${missedText}` };
  if (active.some((s) => s.status === "starting")) return { tone: "accent", state: "Starting", detail: "Starting the capture…" };
  return { tone: "accent", state: "Armed, waiting", detail: `${active[0]!.waitingReason ?? "Waiting for a streamer to record."}${missedText}` };
}

/** Five separate stages, so it is always clear what is and isn't happening. */
export function PipelineStatus({ monitoring }: { monitoring: ReturnType<typeof useMonitoring> }) {
  const m = monitoring.state;
  const { slots, state: capture } = useCapture();
  const { settings } = useSettings();
  const activity = useStorageValue<ChatActivity>(ACTIVITY_KEY) ?? {};
  const user = useStorageValue<TwitchUser>(TWITCH_USER_KEY);
  const streamers = useApiQuery<Page<Streamer>>(`/api/v1/streamers?limit=500&_=${m.lastCheckAt ?? ""}`);
  const stats = useApiQuery<ClipStats>(`/api/v1/clips/stats?_=${slots.map((x) => x.clips).join(",")}:${capture.clips}`);
  const list = streamers.data?.items ?? [];
  const monitored = list.filter((s) => s.monitoring_enabled);
  const liveAutoRecord = monitored.filter((s) => s.auto_record && s.is_live === true);
  const chatValues = Object.values(activity);
  const connected = chatValues.filter((a) => a.chat_state === "connected").length;
  const kickMonitored = monitored.some((s) => s.platform === "kick");

  const discovery: Stage = {
    icon: <Radar className="size-4" />,
    name: "Channel discovery",
    tone: !m.enabled ? "neutral" : m.paused ? "warn" : m.status === "active" ? "live" : m.status === "starting" ? "accent" : "warn",
    state: !m.enabled ? "Off" : m.paused ? "Paused" : m.status === "active" ? "Checking" : m.status === "starting" ? "Starting" : "Problem",
    detail: m.enabled
      ? `${monitored.length} streamer${monitored.length === 1 ? "" : "s"} · last check ${formatRelative(m.lastSuccessAt)} · ${m.liveCount ?? 0} live${m.lastError ? ` · ${m.lastError}` : ""}`
      : `${monitored.length} streamer${monitored.length === 1 ? "" : "s"} on the list. Start monitoring to check live status.`,
  };
  const chat: Stage = {
    icon: <MessageSquare className="size-4" />,
    name: "Chat monitoring",
    tone: !m.enabled || m.paused ? "neutral" : connected > 0 ? "live" : user ? "accent" : "warn",
    state: !m.enabled || m.paused ? "Off" : connected > 0 ? `${connected} connected` : user ? "Waiting for a live stream" : "Not signed in",
    detail: [
      user ? `Twitch: signed in as ${user.login}.` : "Twitch: Sign in with Twitch (Settings → Platforms) to read chat.",
      kickMonitored ? "Kick: not available (Kick only sends chat to servers)." : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
  const video: Stage = { icon: <Video className="size-4" />, name: "Video capture", ...videoStage(slots, liveAutoRecord, settings.recording.maxStreams, capture.message) };
  const recordingAny = slots.some((x) => x.recording);
  const d = slots.map((x) => x.lastDetection).filter((x) => x !== null).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  const lastClipAt = slots.map((x) => x.lastClipAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const detection: Stage = {
    icon: <ScanSearch className="size-4" />,
    name: "Automatic detection",
    tone: recordingAny ? "live" : "neutral",
    state: recordingAny ? (slots.filter((x) => x.recording).length > 1 ? `Running on ${slots.filter((x) => x.recording).length} streams` : "Running") : "Off",
    detail: recordingAny
      ? d
        ? `Last moment ${formatRelative(d.at)}: score ${d.score}${d.clipped ? " → clipped" : " (below the clip threshold)"} · ${d.reasons[0] ?? ""}`
        : "Learning this stream's normal sound and picture (about 30 s), then listening for moments."
      : "Runs only while video is being recorded. Chat and viewer moments without video are kept as provisional.",
  };
  const s = stats.data;
  const exportStage: Stage = {
    icon: <Clapperboard className="size-4" />,
    name: "Clip export",
    tone: lastClipAt ? "live" : "neutral",
    state: `${s?.clips ?? "—"} clips`,
    detail: `${lastClipAt ? `Last clip ${formatRelative(lastClipAt)}. ` : ""}${s ? `${formatBytes(s.clip_bytes)} of clips in this browser.` : ""}`,
  };

  return (
    <Card>
      <CardHeader icon={<Workflow className="size-4" />} title="Pipeline" description="What StreamHunter is doing right now, stage by stage." />
      <CardBody>
        <ol className="space-y-3">
          {[discovery, chat, video, detection, exportStage].map((st) => (
            <li key={st.name} className="flex gap-3" aria-label={`${st.name}: ${st.state}`}>
              <div className="mt-0.5 text-fg-subtle">{st.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-fg">{st.name}</span>
                  <Badge tone={st.tone} icon={<Dot tone={st.tone} pulse={st.tone === "live"} />}>
                    {st.state}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-fg-muted">{st.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
