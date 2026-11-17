import { useEffect, useState } from "react";
import { Volume2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { heardLabel } from "@/components/highlights/HighlightRow";
import { useTabAudio } from "@/hooks/useTabAudio";
import { channelFromUrl, type TabAudioStatus } from "@/types/tab-audio";

const STATUS: Record<Exclude<TabAudioStatus, "off">, { label: string; tone: "live" | "warn" | "danger" }> = {
  measuring: { label: "Measuring", tone: "live" },
  waiting: { label: "Not monitored", tone: "warn" },
  error: { label: "Not delivered", tone: "danger" },
};

/** One line about live sound detection, or null when it is off. */
export function soundLine(state: { sounds: boolean; soundState: string | null; heard: Parameters<typeof heardLabel>[0] }): string | null {
  if (!state.sounds) return null;
  if (state.soundState === "not_installed")
    return "Laughter detection isn't installed on the backend (pip install -r requirements-media.txt).";
  if (state.soundState?.startsWith("failed: ")) return `Laughter detection failed: ${state.soundState.slice(8)}`;
  if (state.soundState !== "receiving") return "Listening for laughter and cheering…";
  const heard = heardLabel(state.heard);
  return heard ? `Hearing ${heard}` : "Listening for laughter and cheering: nothing yet";
}

const PLATFORM_HOST = { twitch: "twitch.tv", kick: "kick.com" } as const;

/**
 * Popup control for live tab audio. It has to live in the popup: opening the popup on the
 * stream tab is the user action that allows Chrome to capture that tab.
 */
export function TabAudioControl() {
  const audio = useTabAudio();
  const [tab, setTab] = useState<{ id: number; url: string } | null>(null);
  const [sounds, setSounds] = useState(false);

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
  const { state } = audio;

  return (
    <section className="border-t border-ink-700 px-4 py-3 text-xs" aria-labelledby="tab-audio-title">
      <h2 id="tab-audio-title" className="mb-1.5 flex items-center gap-1.5 font-semibold text-fg-muted">
        <Volume2 className="size-3.5" /> Tab audio
        {state.status !== "off" && <Badge tone={STATUS[state.status].tone}>{STATUS[state.status].label}</Badge>}
      </h2>
      {state.status !== "off" && state.platform && state.channel ? (
        <div className="space-y-2">
          <p className="text-fg">
            {PLATFORM_HOST[state.platform]}/{state.channel}
            {state.levelDb !== null && <span className="text-fg-muted tabular"> · {state.levelDb.toFixed(0)} dB</span>}
          </p>
          {state.message && <p className="text-fg-muted">{state.message}</p>}
          {soundLine(state) && <p className="text-fg-muted">{soundLine(state)}</p>}
          <Button size="sm" variant="secondary" className="w-full" loading={audio.busy} onClick={() => void audio.stop()}>
            Stop measuring
          </Button>
        </div>
      ) : target && tab ? (
        <div className="space-y-2">
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            loading={audio.busy}
            onClick={() => void audio.start(tab.id, tab.url, sounds)}
          >
            Measure this tab's audio ({target.channel})
          </Button>
          <p className="text-fg-subtle">
            Adds stream loudness to live highlight detection. Only one loudness number per second is sent to your backend, and
            the tab stays audible.
          </p>
          <label className="flex items-start gap-2 text-fg-muted">
            <input type="checkbox" className="mt-0.5" checked={sounds} onChange={(e) => setSounds(e.target.checked)} />
            <span>
              Also detect laughter and cheering. This sends the tab's audio to your StreamHunter backend, which listens for
              them and keeps only the result; the audio is not stored.
            </span>
          </label>
        </div>
      ) : (
        <p className="text-fg-subtle">
          {state.message ?? "Open a Twitch or Kick channel in this tab to add its audio to live highlight detection."}
        </p>
      )}
      {audio.error && (
        <p role="alert" className="mt-2 text-danger">
          {audio.error}
        </p>
      )}
    </section>
  );
}
