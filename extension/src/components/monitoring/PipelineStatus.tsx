import type { ReactNode } from "react";
import { Clapperboard, MessageSquare, Radar, ScanSearch, Video, Workflow } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, Dot, type BadgeTone } from "@/components/ui/Badge";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useCapture } from "@/hooks/useCapture";
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

/** Honest state of the video stage: never "recording" unless frames are being encoded. */
export function videoStage(capture: CaptureState, liveAutoRecord: Streamer[]): Pick<Stage, "tone" | "state" | "detail"> {
  if (capture.status === "capturing") {
    const who = capture.channel ?? "the stream";
    if (capture.recording) {
      const silent = capture.silentSeconds >= 20 ? " No sound for a while: is the player muted?" : "";
      return {
        tone: capture.silentSeconds >= 20 ? "warn" : "live",
        state: "Recording",
        detail: `${capture.mode === "recorder" ? "Recorder tab" : "Captured tab"}: ${who}, ${capture.bufferedSeconds} s in the buffer.${silent}`,
      };
    }
    if (capture.paused) return { tone: "warn", state: "Paused", detail: "The recorder tab is armed; recording resumes with monitoring." };
    return { tone: "accent", state: "Armed, waiting", detail: capture.waitingReason ?? "Waiting for a streamer to record." };
  }
  if (capture.status === "starting") return { tone: "accent", state: "Starting", detail: "Starting the capture…" };
  if (liveAutoRecord.length > 0)
    return {
      tone: "danger",
      state: "Inactive",
      detail: `${liveAutoRecord.map((s) => s.display_name).join(", ")} ${liveAutoRecord.length === 1 ? "is" : "are"} live and detected, but video capture is inactive. Open a Twitch or Kick tab, click the StreamHunter icon and choose Use this tab as the recorder.`,
    };
  return {
    tone: "neutral",
    state: "Off",
    detail: capture.message ?? "No recorder tab. Only live status and chat are monitored; there is no video to clip.",
  };
}

/** Five separate stages, so it is always clear what is and isn't happening. */
export function PipelineStatus({ monitoring }: { monitoring: ReturnType<typeof useMonitoring> }) {
  const m = monitoring.state;
  const { state: capture } = useCapture();
  const activity = useStorageValue<ChatActivity>(ACTIVITY_KEY) ?? {};
  const user = useStorageValue<TwitchUser>(TWITCH_USER_KEY);
  const streamers = useApiQuery<Page<Streamer>>(`/api/v1/streamers?limit=500&_=${m.lastCheckAt ?? ""}`);
  const stats = useApiQuery<ClipStats>(`/api/v1/clips/stats?_=${capture.clips}:${capture.lastClipAt ?? ""}`);
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
  const video: Stage = { icon: <Video className="size-4" />, name: "Video capture", ...videoStage(capture, liveAutoRecord) };
  const d = capture.lastDetection;
  const detection: Stage = {
    icon: <ScanSearch className="size-4" />,
    name: "Automatic detection",
    tone: capture.recording ? "live" : "neutral",
    state: capture.recording ? "Running" : "Off",
    detail: capture.recording
      ? d
        ? `Last moment ${formatRelative(d.at)}: score ${d.score}${d.clipped ? " → clipped" : " (below the clip threshold)"} · ${d.reasons[0] ?? ""}`
        : "Learning this stream's normal sound and picture (about 30 s), then listening for moments."
      : "Runs only while video is being recorded. Chat and viewer moments without video are kept as provisional.",
  };
  const s = stats.data;
  const exportStage: Stage = {
    icon: <Clapperboard className="size-4" />,
    name: "Clip export",
    tone: capture.clips > 0 ? "live" : "neutral",
    state: `${s?.clips ?? "—"} clips`,
    detail: `${capture.lastClipAt ? `Last clip ${formatRelative(capture.lastClipAt)}. ` : ""}${s ? `${formatBytes(s.clip_bytes)} of clips in this browser.` : ""}`,
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
