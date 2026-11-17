import { useEffect, useState } from "react";
import { Circle, Scissors, Square, Video } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useCapture } from "@/hooks/useCapture";
import { channelFromUrl } from "@/types/capture";
import { formatRelative } from "@/utils/format";

const PLATFORM_HOST = { twitch: "twitch.tv", kick: "kick.com" } as const;

/**
 * Popup control for capture mode. It has to live in the popup: opening the popup on the stream tab
 * is the click that allows Chrome to capture that tab.
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

  return (
    <section className="border-t border-ink-700 px-4 py-3 text-xs" aria-labelledby="capture-title">
      <h2 id="capture-title" className="mb-1.5 flex items-center gap-1.5 font-semibold text-fg-muted">
        <Video className="size-3.5" /> Capture
        {active && <Badge tone="live">{state.status === "starting" ? "Starting" : "Recording"}</Badge>}
      </h2>
      {active && state.platform && state.channel ? (
        <div className="space-y-2">
          <p className="text-fg">
            {PLATFORM_HOST[state.platform]}/{state.channel}
            <span className="text-fg-muted tabular">
              {" "}
              · {state.bufferedSeconds} s buffered{state.levelDb !== null ? ` · ${state.levelDb.toFixed(0)} dB` : ""}
            </span>
          </p>
          <p className="text-fg-muted">
            {state.clips} clip{state.clips === 1 ? "" : "s"} saved{state.lastClipAt ? ` · last ${formatRelative(state.lastClipAt)}` : ""}
          </p>
          {state.message && <p className="text-fg-muted">{state.message}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="primary" loading={capture.busy} icon={<Scissors className="size-3.5" />} onClick={() => void capture.saveLast(30)}>
              Save last 30 s
            </Button>
            <Button size="sm" variant="secondary" loading={capture.busy} icon={<Square className="size-3.5" />} onClick={() => void capture.stop()}>
              Stop capture
            </Button>
          </div>
        </div>
      ) : target && tab ? (
        <div className="space-y-2">
          <Button size="sm" variant="secondary" className="w-full" loading={capture.busy} icon={<Circle className="size-3.5" />} onClick={() => void capture.start(tab.id, tab.url)}>
            Capture this stream ({target.channel})
          </Button>
          <p className="text-fg-subtle">
            Keeps the last 2 minutes of this tab's video and audio in memory. Moments StreamHunter detects (chat, sound, action) and
            "Save last 30 s" become MP4 clips in your Clip Library. Nothing is uploaded; the tab stays audible.
          </p>
          {state.message && <p className="text-fg-muted">{state.message}</p>}
        </div>
      ) : (
        <p className="text-fg-subtle">{state.message ?? "Open a Twitch or Kick channel in this tab to capture it and get real clips."}</p>
      )}
      {capture.error && (
        <p role="alert" className="mt-2 text-danger">
          {capture.error}
        </p>
      )}
    </section>
  );
}
