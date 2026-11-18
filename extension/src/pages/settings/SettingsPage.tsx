import { useMemo, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Segmented";
import { useSettings } from "@/hooks/useSettings";
import { LIMITS, SUPPORTED_KEYWORD_LANGUAGES, type Sensitivity } from "@/types/settings";
import { cn } from "@/utils/cn";
import { NumberField, Section } from "./sections";
import { maxSingleSignalScore } from "@/detection/fusion";

const WEIGHT_LABEL = { audio: "Audio reaction", chat: "Chat activity", visual: "Visual activity", viewers: "Viewer spike", multi: "Several signals together" } as const;
import { PlatformConnections } from "./PlatformConnections";

function KeywordEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const full = value.length >= LIMITS.customKeywords.maxItems;
  const add = () => {
    const k = draft.trim().slice(0, LIMITS.customKeywords.maxLength);
    if (!k || full) return;
    if (!value.some((v) => v.toLocaleLowerCase() === k.toLocaleLowerCase())) onChange([...value, k]);
    setDraft("");
  };
  return (
    <Field label="Custom reaction phrases" hint={`Added to the language packs, e.g. "clip it", "no shot". Up to ${LIMITS.customKeywords.maxItems}.`}>
      {({ id, describedBy }) => (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              id={id}
              aria-describedby={describedBy}
              value={draft}
              maxLength={LIMITS.customKeywords.maxLength}
              disabled={full}
              placeholder="Type a phrase and press Enter"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button onClick={add} disabled={!draft.trim() || full}>
              Add
            </Button>
          </div>
          {value.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Custom phrases">
              {value.map((k) => (
                <li key={k} className="inline-flex items-center gap-1 rounded-md border border-ink-600 bg-ink-800 py-0.5 pr-1 pl-2 text-xs text-fg">
                  {k}
                  <button
                    type="button"
                    aria-label={`Remove ${k}`}
                    onClick={() => onChange(value.filter((v) => v !== k))}
                    className="cursor-pointer rounded p-0.5 text-fg-subtle hover:bg-ink-600 hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}

const SENSITIVITY_OPTIONS: readonly { id: Sensitivity; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

export function SettingsPage() {
  const { settings: s, loaded, update, reset } = useSettings();
  const [confirmReset, setConfirmReset] = useState(false);
  const timeZones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [] as string[];
    }
  }, []);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (!loaded) return null;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Changes are saved automatically and stored locally in this browser."
        actions={
          confirmReset ? (
            <>
              <span className="text-xs text-fg-muted">Reset all settings?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await reset();
                  setConfirmReset(false);
                }}
              >
                Reset
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirmReset(true)}>
              Reset to defaults
            </Button>
          )
        }
      />

      <div className="border-t border-ink-700">
        <Section
          id="connections"
          title="Platforms"
          description="StreamHunter talks to Twitch and Kick directly from this browser, with your own free developer app for each platform."
        >
          <PlatformConnections />
        </Section>

        <Section id="monitoring" title="Monitoring" description="Monitoring only runs while Chrome is open. Longer intervals use fewer API requests.">
          <Field inline label="Check interval" hint={`${LIMITS.intervalMinutes.min}–${LIMITS.intervalMinutes.max} minutes between live-status checks (one batched request per platform).`}>
            {({ id, describedBy }) => (
              <NumberField
                id={id}
                describedBy={describedBy}
                value={s.monitoring.intervalMinutes}
                min={LIMITS.intervalMinutes.min}
                max={LIMITS.intervalMinutes.max}
                suffix="min"
                onCommit={(intervalMinutes) => void update({ monitoring: { intervalMinutes } })}
              />
            )}
          </Field>
          <Field inline label="Resume when Chrome starts" hint="Continue monitoring automatically if it was on when Chrome closed.">
            {({ id }) => (
              <Switch id={id} label="Resume when Chrome starts" checked={s.monitoring.resumeOnStartup} onChange={(resumeOnStartup) => void update({ monitoring: { resumeOnStartup } })} />
            )}
          </Field>
        </Section>

        <Section id="detection" title="Detection" description="How eager StreamHunter is to flag a moment. Spikes are always measured against each stream's own normal chat activity.">
          <Field inline label="Sensitivity" hint="High finds more moments but also more false positives.">
            {() => (
              <Segmented label="Sensitivity" value={s.detection.sensitivity} options={SENSITIVITY_OPTIONS} onChange={(sensitivity) => void update({ detection: { sensitivity } })} />
            )}
          </Field>
          <Field inline label="Minimum highlight score" hint="Candidates below this score (0–100) are hidden from your review queue.">
            {({ id, describedBy }) => (
              <NumberField
                id={id}
                describedBy={describedBy}
                value={s.detection.minHighlightScore}
                min={LIMITS.minHighlightScore.min}
                max={LIMITS.minHighlightScore.max}
                onCommit={(minHighlightScore) => void update({ detection: { minHighlightScore } })}
              />
            )}
          </Field>
          <fieldset>
            <legend className="text-sm font-medium text-fg">Reaction language packs</legend>
            <p className="mt-0.5 text-xs text-fg-muted">Keywords and expressions are matched in these languages. Emotes are language independent.</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {SUPPORTED_KEYWORD_LANGUAGES.map((l) => {
                const on = s.detection.keywordLanguages.includes(l.code);
                return (
                  <button
                    key={l.code}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      void update({
                        detection: {
                          keywordLanguages: on ? s.detection.keywordLanguages.filter((c) => c !== l.code) : [...s.detection.keywordLanguages, l.code],
                        },
                      })
                    }
                    className={cn(
                      "cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors",
                      on ? "border-accent/50 bg-accent-soft text-fg" : "border-ink-600 text-fg-muted hover:text-fg",
                    )}
                  >
                    {l.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <KeywordEditor value={s.detection.customKeywords} onChange={(customKeywords) => void update({ detection: { customKeywords } })} />
        </Section>

        <Section
          id="scoring"
          title="Automatic clipping"
          description="Each signal adds up to its points at full strength; two or more kinds firing together add the bonus. A clip is made when the total reaches the threshold."
        >
          {(["audio", "chat", "visual", "viewers", "multi"] as const).map((k) => (
            <Field key={k} inline label={WEIGHT_LABEL[k]}>
              {({ id }) => (
                <NumberField id={id} value={s.detection.weights[k]} min={LIMITS.weight.min} max={LIMITS.weight.max} suffix="pts" onCommit={(v) => void update({ detection: { weights: { [k]: v } } })} />
              )}
            </Field>
          ))}
          <Field inline label="Clip threshold" hint="Minimum combined score (0–100) for an automatic clip.">
            {({ id, describedBy }) => (
              <NumberField id={id} describedBy={describedBy} value={s.detection.clipThreshold} min={0} max={100} onCommit={(clipThreshold) => void update({ detection: { clipThreshold } })} />
            )}
          </Field>
          {maxSingleSignalScore(s.detection.weights) >= s.detection.clipThreshold && (
            <p role="status" className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
              With these values a single signal can reach the threshold on its own, so you may get clips from one loud sound or one chat burst.
            </p>
          )}
        </Section>

        <Section id="clips" title="Clips & recording" description="How much of the stream a clip keeps around a detected moment, and how much is kept in memory while recording.">
          <Field inline label="Seconds before the moment">
            {({ id }) => (
              <NumberField id={id} value={s.clips.preRollSeconds} min={LIMITS.rollSeconds.min} max={LIMITS.rollSeconds.max} suffix="s" onCommit={(preRollSeconds) => void update({ clips: { preRollSeconds } })} />
            )}
          </Field>
          <Field inline label="Seconds after the moment">
            {({ id }) => (
              <NumberField id={id} value={s.clips.postRollSeconds} min={LIMITS.rollSeconds.min} max={LIMITS.rollSeconds.max} suffix="s" onCommit={(postRollSeconds) => void update({ clips: { postRollSeconds } })} />
            )}
          </Field>
          <Field inline label="Rolling buffer" hint="Kept in memory while recording (about 0.4 MB per second at 720p). Always at least before + after + 70 s.">
            {({ id, describedBy }) => (
              <NumberField id={id} describedBy={describedBy} value={s.clips.bufferSeconds} min={LIMITS.bufferSeconds.min} max={LIMITS.bufferSeconds.max} suffix="s" onCommit={(bufferSeconds) => void update({ clips: { bufferSeconds } })} />
            )}
          </Field>
          <Field inline label="Longest clip" hint="Overlapping moments extend one clip up to this length instead of saving the same footage twice.">
            {({ id, describedBy }) => (
              <NumberField id={id} describedBy={describedBy} value={s.clips.maxClipSeconds} min={LIMITS.maxClipSeconds.min} max={LIMITS.maxClipSeconds.max} suffix="s" onCommit={(maxClipSeconds) => void update({ clips: { maxClipSeconds } })} />
            )}
          </Field>
          <Field inline label="Also create a Twitch clip" hint="Optional. For Twitch clips, also asks Twitch to create a clip on your account (public on Twitch). Needs Sign in with Twitch with clip permission.">
            {({ id }) => (
              <Switch id={id} label="Also create a Twitch clip" checked={s.clips.twitchNativeClips} onChange={(twitchNativeClips) => void update({ clips: { twitchNativeClips } })} />
            )}
          </Field>
        </Section>

        <Section id="recording" title="Recording" description="How many streams are recorded at once. Each one needs its own recorder tab, armed with one click. Measured on an Apple M5: each stream costs about 0.1–0.15 of a CPU core to record plus the Twitch player itself (roughly 0.15–0.3 core and 300–600 MB), and 6–8 Mbit/s of download.">
          <Field inline label="Simultaneous streams" hint="1 keeps today's single-recorder behaviour. 3 is comfortable on a 16 GB Mac; 5 works if little else runs.">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} className="w-40" value={String(s.recording.maxStreams)} onChange={(e) => void update({ recording: { maxStreams: Number(e.target.value) } })}>
                {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? "stream" : "streams"}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field inline label="Recording quality" hint="Applies to recordings started after the change.">
            {({ id }) => (
              <Select id={id} className="w-56" value={s.recording.quality} onChange={(e) => void update({ recording: { quality: e.target.value as "720p" | "480p" } })}>
                <option value="720p">720p, 3 Mbit/s (≈ 22 MB/min)</option>
                <option value="480p">480p, 1.5 Mbit/s (≈ 11 MB/min)</option>
              </Select>
            )}
          </Field>
          <Field inline label="Sound" hint="Recording captures every stream's sound either way; this only decides what you hear.">
            {({ id }) => (
              <Select id={id} className="w-56" value={s.recording.audio} onChange={(e) => void update({ recording: { audio: e.target.value as "first" | "none" } })}>
                <option value="first">Play the first stream's sound</option>
                <option value="none">Silent</option>
              </Select>
            )}
          </Field>
          <Field inline label="Overload protection" hint="When CPU stays above 90%, free memory drops below 1.5 GB or a stream falls behind: no new streams, then the lowest-priority stream drops to half frame rate, then pauses. Undone after a minute of normal load.">
            {({ id }) => (
              <Switch id={id} label="Overload protection" checked={s.recording.protectResources} onChange={(protectResources) => void update({ recording: { protectResources } })} />
            )}
          </Field>
        </Section>

        <Section id="storage" title="Storage" description="Clips are stored in this browser. When they take more space than allowed, the oldest are deleted automatically. Favourites are never deleted automatically.">
          <Field inline label="Maximum clip storage">
            {({ id }) => (
              <NumberField id={id} value={s.storage.maxTotalMb} min={LIMITS.maxTotalMb.min} max={LIMITS.maxTotalMb.max} suffix="MB" onCommit={(maxTotalMb) => void update({ storage: { maxTotalMb } })} />
            )}
          </Field>
          <Field inline label="Delete clips older than" hint="0 keeps clips until the storage limit is reached.">
            {({ id, describedBy }) => (
              <NumberField id={id} describedBy={describedBy} value={s.storage.maxAgeDays} min={LIMITS.maxAgeDays.min} max={LIMITS.maxAgeDays.max} suffix="days" onCommit={(maxAgeDays) => void update({ storage: { maxAgeDays } })} />
            )}
          </Field>
        </Section>

        <Section id="notifications" title="Notifications" description="Desktop notifications are delivered by Chrome while it is open.">
          <Field inline label="New highlight detected">
            {({ id }) => <Switch id={id} label="New highlight detected" checked={s.notifications.onHighlight} onChange={(onHighlight) => void update({ notifications: { onHighlight } })} />}
          </Field>
          <Field inline label="Streamer goes live">
            {({ id }) => <Switch id={id} label="Streamer goes live" checked={s.notifications.onStreamerLive} onChange={(onStreamerLive) => void update({ notifications: { onStreamerLive } })} />}
          </Field>
        </Section>

        <Section id="locale" title="Language & time" description="Timestamps are stored in UTC and shown in this time zone.">
          <Field inline label="Time zone" hint={s.locale.timeZone === "auto" ? `Using browser time zone (${browserTz}).` : undefined}>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} className="w-60" value={s.locale.timeZone} onChange={(e) => void update({ locale: { timeZone: e.target.value } })}>
                <option value="auto">Automatic</option>
                {timeZones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field inline label="Interface language" hint="More interface languages will follow.">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} className="w-60" value={s.locale.language} onChange={(e) => void update({ locale: { language: e.target.value } })}>
                <option value="en">English</option>
              </Select>
            )}
          </Field>
        </Section>

        <Section id="privacy" title="Privacy & data" description="Everything stays in this browser. Chat messages are analysed in memory and discarded; only highlights are kept.">
          <Field inline label="Keep provisional highlights for" hint="Highlights without video and ended sessions older than this are deleted. Clips are kept until you delete them.">
            {({ id, describedBy }) => (
              <NumberField
                id={id}
                describedBy={describedBy}
                value={s.privacy.retentionDays}
                min={LIMITS.retentionDays.min}
                max={LIMITS.retentionDays.max}
                suffix="days"
                className="w-36"
                onCommit={(retentionDays) => void update({ privacy: { retentionDays } })}
              />
            )}
          </Field>
        </Section>
      </div>
    </>
  );
}
