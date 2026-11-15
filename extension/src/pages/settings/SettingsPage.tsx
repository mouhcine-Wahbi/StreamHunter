import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Segmented";
import { useSettings } from "@/hooks/useSettings";
import { sendRequest } from "@/services/runtime";
import { LIMITS, SUPPORTED_KEYWORD_LANGUAGES, type AspectRatio, type Sensitivity } from "@/types/settings";
import { normalizeBackendUrl } from "@/utils/settings";
import { cn } from "@/utils/cn";
import { NumberField, Section } from "./sections";
import { PlatformConnections } from "./PlatformConnections";
import { AccountSection } from "./AccountSection";

function BackendUrlForm({ value, onSave }: { value: string; onSave: (url: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(value), [value]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const url = normalizeBackendUrl(draft);
    if (!url) {
      setError("Use https://… (http is only allowed for localhost / 127.0.0.1).");
      return;
    }
    const origin = new URL(url).origin;
    const isLocal = ["http://localhost:8000", "http://127.0.0.1:8000"].includes(origin);
    if (!isLocal) {
      // Remote backends need an optional host permission, granted by the user from this click.
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
      if (!granted) {
        setError(`Chrome permission to contact ${origin} was not granted.`);
        return;
      }
    }
    setError(null);
    await onSave(url);
    setSaved(true);
    void sendRequest({ type: "monitoring/check-now" }).catch(() => undefined);
  }

  return (
    <form onSubmit={submit}>
      <Field label="Backend URL" hint={!error ? "The StreamHunter API server. Platform credentials live there, never in the extension." : undefined} error={error}>
        {({ id, describedBy }) => (
          <div className="flex gap-2">
            <Input id={id} aria-describedby={describedBy} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} className="font-mono" />
            <Button type="submit" variant="secondary" icon={saved ? <Check className="size-4 text-live" /> : undefined}>
              {saved ? "Saved" : "Save"}
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
}

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
const RATIO_OPTIONS: readonly { id: AspectRatio; label: string }[] = [
  { id: "9:16", label: "9:16 Vertical" },
  { id: "16:9", label: "16:9 Landscape" },
  { id: "1:1", label: "1:1 Square" },
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
        <Section id="backend" title="Backend" description="Where the extension sends requests. Use HTTPS for anything that is not your own machine.">
          <BackendUrlForm value={s.backendUrl} onSave={(backendUrl) => update({ backendUrl })} />
        </Section>

        <Section id="account" title="Account" description="Your StreamHunter account on this backend. Your watchlist, highlights and clips belong to it.">
          <AccountSection />
        </Section>

        <Section
          id="connections"
          title="Platform connections"
          description="Twitch and Kick accounts are connected through the backend with OAuth. What each platform allows is reported by the backend."
        >
          <PlatformConnections />
        </Section>

        <Section id="monitoring" title="Monitoring" description="Monitoring only runs while Chrome is open. Longer intervals use fewer API requests.">
          <Field inline label="Check interval" hint={`${LIMITS.intervalMinutes.min}–${LIMITS.intervalMinutes.max} minutes between heartbeats and status checks.`}>
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

        <Section id="clips" title="Clips" description="Defaults for clip windows and exports. Exports only run when StreamHunter has authorized access to the media.">
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
          <Field inline label="Default aspect ratio">
            {({ id }) => (
              <Select id={id} className="w-44" value={s.clips.defaultAspectRatio} onChange={(e) => void update({ clips: { defaultAspectRatio: e.target.value as AspectRatio } })}>
                {RATIO_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
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

        <Section id="privacy" title="Privacy & data" description="StreamHunter keeps chat statistics, not chat logs. Raw messages are processed in memory and discarded.">
          <Field inline label="Keep events and statistics for" hint="Older detection events are deleted by the backend.">
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
