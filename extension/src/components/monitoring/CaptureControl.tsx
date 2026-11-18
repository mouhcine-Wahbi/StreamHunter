import { useEffect, useState } from "react";
import { Circle, Clapperboard, Scissors, Square, Video } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useCapture } from "@/hooks/useCapture";
import { channelFromUrl } from "@/types/capture";
import { formatRelative } from "@/utils/format";

const PLATFORM_HOST = { twitch: "twitch.tv", kick: "kick.com" } as const;

/** Twitch or Kick page (any path): can become the recorder tab. */
export function isStreamSite(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)(twitch\.tv|kick\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Popup control for capture. It has to live in the popup: opening the popup on a tab is the click
 * that allows Chrome to capture that tab. Two ways:
 * - Use this tab as the recorder (automatic): StreamHunter navigates it to whichever Auto-record
 *   streamer is live and records only while one is.
 * - Capture this stream (manual): records the channel open in this tab.
 */
export function CaptureControl() {
  const capture = useCapture();
  const [tab, setTab] = useState<{ id: number; url: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void chrome.tabs
      ?.query?.({ active: true, currentWindow: true })
      .then(([t]) => alive && t?.id !== undefined && t.url && setTab({ id: t.id, url: t.url }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const target = channelFromUrl(tab?.url);
  const { state } = capture;
  const active = state.status === "capturing" || state.status === "starting";
  const where = state.platform && state.channel ? `${PLATFORM_HOST[state.platform]}/${state.channel}` : null;

  return (
    <section className="border-t border-ink-700 px-4 py-3 text-xs" aria-labelledby="capture-title">
      <h2 id="capture-title" className="mb-1.5 flex items-center gap-1.5 font-semibold text-fg-muted">
        <Video className="size-3.5" /> Video capture
        {active && (
          <Badge tone={state.recording ? "live" : "accent"}>
            {state.status === "starting" ? "Starting" : state.recording ? "Recording" : state.paused ? "Paused" : "Armed"}
          </Badge>
        )}
      </h2>
      {active ? (
        <div className="space-y-2">
          <p className="text-fg">
            {state.mode === "recorder" ? "Recorder tab" : "Captured tab"}
            {state.recording && where ? `: ${where}` : ""}
            {state.recording && <span className="text-fg-muted tabular"> · {state.bufferedSeconds} s buffered</span>}
          </p>
          {!state.recording && state.waitingReason && <p className="text-fg-muted">{state.waitingReason}</p>}
          {state.recording && state.silentSeconds >= 20 && <p className="text-warn">No sound from the tab for {state.silentSeconds} s. Is the player muted?</p>}
          <p className="text-fg-muted">
            {state.clips} clip{state.clips === 1 ? "" : "s"} saved{state.lastClipAt ? ` · last ${formatRelative(state.lastClipAt)}` : ""}
          </p>
          {state.message && <p className="text-fg-muted">{state.message}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="primary" disabled={!state.recording} loading={capture.busy} icon={<Scissors className="size-3.5" />} onClick={() => void capture.saveLast(30)}>
              Save last 30 s
            </Button>
            <Button size="sm" variant="secondary" loading={capture.busy} icon={<Square className="size-3.5" />} onClick={() => void capture.stop()}>
              Stop capture
            </Button>
          </div>
        </div>
      ) : tab && isStreamSite(tab.url) ? (
        <div className="space-y-2">
          <Button size="sm" variant="primary" className="w-full" loading={capture.busy} icon={<Clapperboard className="size-3.5" />} onClick={() => void capture.arm(tab.id)}>
            Use this tab as the recorder
          </Button>
          <p className="text-fg-subtle">
            Automatic: StreamHunter switches this tab to whichever Auto-record streamer is live, records only while one is, and turns detected moments
            into MP4 clips. Keep the tab open (it can be in the background) and the player unmuted.
          </p>
          {target && (
            <Button size="sm" variant="ghost" className="w-full" loading={capture.busy} icon={<Circle className="size-3.5" />} onClick={() => void capture.start(tab.id, tab.url)}>
              Only capture this stream ({target.channel})
            </Button>
          )}
          {state.message && <p className="text-fg-muted">{state.message}</p>}
        </div>
      ) : (
        <p className="text-fg-subtle">{state.message ?? "Open twitch.tv or kick.com in this tab to record from it. Without a recorder tab, there is no video to clip."}</p>
      )}
      {capture.error && (
        <p role="alert" className="mt-2 text-danger">
          {capture.error}
        </p>
      )}
    </section>
  );
}
