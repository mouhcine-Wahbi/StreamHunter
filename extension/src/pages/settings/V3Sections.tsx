/**
 * StreamHunter 3.0 settings: content discovery, output formats, scoring, titles/descriptions and AI.
 * Each section only edits its own part of the settings; everything is sanitized on save.
 */
import { useEffect, useState } from "react";
import { Field, Input, Select } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { YT_CATEGORIES } from "@/discovery/runner";
import { DEFAULT_CLAUDE_MODEL, getAiKeys, setAiKey, type AiKeys, type OnDeviceState } from "@/metadata/generate";
import { FACTOR_LABEL, type FactorKey } from "@/scoring/score";
import { sendRequest } from "@/services/runtime";
import type { DeepPartial, Settings } from "@/types/settings";
import { KeywordEditor, NumberField, Section } from "./sections";
import { CompanionSection } from "./CompanionSection";

export interface V3SectionProps {
  s: Settings;
  update: (patch: DeepPartial<Settings>) => Promise<unknown>;
}

export function DiscoverySection({ s, update }: V3SectionProps) {
  const d = s.discovery;
  const set = (discovery: DeepPartial<Settings["discovery"]>) => void update({ discovery });
  return (
    <Section
      id="discovery"
      title="Content discovery"
      description="Finds videos worth a look. Discovered videos are only candidates: StreamHunter never downloads or processes them. To work with one you add the file yourself and state your rights. YouTube needs your API key (Settings → Platforms; 10,000 units a day)."
    >
      <Field inline label="Automatic discovery" hint="Runs while Chrome is open. You can always run it from Content Discovery.">
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Automatic discovery" checked={d.enabled} onChange={(enabled) => set({ enabled })} />}
      </Field>
      <Field inline label="Run every" hint="0 = only when you click Run discovery.">
        {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={d.intervalHours} min={0} max={168} suffix="hours" className="w-36" onCommit={(intervalHours) => set({ intervalHours })} />}
      </Field>
      <Field inline label="YouTube trending region" hint="Two-letter country code, e.g. US, GB, FR.">
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            className="w-20 uppercase"
            maxLength={2}
            defaultValue={d.youtubeRegion}
            onBlur={(e) => {
              const v = e.target.value.trim().toUpperCase();
              if (/^[A-Z]{2}$/.test(v)) set({ youtubeRegion: v });
              else e.target.value = d.youtubeRegion;
            }}
          />
        )}
      </Field>
      <Field label="YouTube trending categories" hint="Each category costs 1 unit per run. None selected = all categories.">
        {() => (
          <div className="flex flex-wrap gap-3 text-sm" role="group" aria-label="YouTube trending categories">
            {Object.entries(YT_CATEGORIES)
              .filter(([id]) => id)
              .map(([id, name]) => (
                <label key={id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={d.youtubeCategories.includes(id)}
                    onChange={(e) => set({ youtubeCategories: e.target.checked ? [...d.youtubeCategories, id] : d.youtubeCategories.filter((x) => x !== id) })}
                  />
                  {name}
                </label>
              ))}
          </div>
        )}
      </Field>
      <Field inline label="Twitch trending clips" hint="Most-viewed recent clips in the top Twitch categories.">
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Twitch trending clips" checked={d.twitchTrending} onChange={(twitchTrending) => set({ twitchTrending })} />}
      </Field>
      <Field inline label="Top Twitch categories">
        {({ id }) => <NumberField id={id} value={d.twitchTopGames} min={0} max={10} onCommit={(twitchTopGames) => set({ twitchTopGames })} />}
      </Field>
      <KeywordEditor
        label="Keywords"
        hint="Topics, gaming categories or creator names. Each keyword is matched to a Twitch category; YouTube search is optional below. Up to 20."
        listLabel="Discovery keywords"
        maxItems={20}
        maxLength={60}
        value={d.keywords}
        onChange={(keywords) => set({ keywords })}
      />
      <Field inline label="Also search YouTube for keywords" hint="Costs 101 of your 10,000 daily units per keyword and run.">
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Also search YouTube for keywords" checked={d.keywordYouTube} onChange={(keywordYouTube) => set({ keywordYouTube })} />}
      </Field>
      <Field inline label="Language" hint="Two-letter code (e.g. en); empty = any.">
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            className="w-20"
            maxLength={2}
            defaultValue={d.language}
            onBlur={(e) => {
              const v = e.target.value.trim().toLowerCase();
              if (v === "" || /^[a-z]{2}$/.test(v)) set({ language: v });
              else e.target.value = d.language;
            }}
          />
        )}
      </Field>
      <Field inline label="Only videos newer than" hint="0 = any age.">
        {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={d.maxAgeDays} min={0} max={365} suffix="days" className="w-36" onCommit={(maxAgeDays) => set({ maxAgeDays })} />}
      </Field>
      <Field inline label="Minimum views">
        {({ id }) => <NumberField id={id} value={d.minViews} min={0} max={100_000_000} className="w-40" onCommit={(minViews) => set({ minViews })} />}
      </Field>
      <Field inline label="Minimum engagement" hint="(Likes + comments) ÷ views. Twitch clips don't report it.">
        {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={d.minEngagementPct} min={0} max={100} suffix="%" onCommit={(minEngagementPct) => set({ minEngagementPct })} />}
      </Field>
      <Field inline label="Results per source">
        {({ id }) => <NumberField id={id} value={d.perSourceMax} min={1} max={50} onCommit={(perSourceMax) => set({ perSourceMax })} />}
      </Field>
    </Section>
  );
}

export function FormatsSection({ s, update }: V3SectionProps) {
  const f = s.formats;
  return (
    <Section id="formats" title="Output formats" description="Which versions StreamHunter makes of each clip. Vertical 9:16 is for YouTube Shorts and TikTok; landscape is for X. Each creator and each clip can use a different layout.">
      <Field inline label="Vertical 9:16 (Shorts, TikTok)">
        {({ id }) => <Switch id={id} label="Vertical 9:16" checked={f.vertical} onChange={(vertical) => void update({ formats: { vertical } })} />}
      </Field>
      <Field inline label="Landscape (X)" hint="Reuses the original clip when it already meets X's limits.">
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Landscape" checked={f.landscape} onChange={(landscape) => void update({ formats: { landscape } })} />}
      </Field>
      <Field inline label="Default vertical layout" hint="Facecam above gameplay needs the facecam position, set per creator in My Creators; otherwise the centre is used.">
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} className="w-60" value={f.verticalLayout} onChange={(e) => void update({ formats: { verticalLayout: e.target.value as Settings["formats"]["verticalLayout"] } })}>
            <option value="facecam_top">Facecam above gameplay</option>
            <option value="action">Follow the action</option>
            <option value="center">Centre crop</option>
          </Select>
        )}
      </Field>
    </Section>
  );
}

export function ScoringSection({ s, update }: V3SectionProps) {
  const sc = s.scoring;
  const sum = Object.values(sc.weights).reduce((a, b) => a + b, 0);
  return (
    <Section
      id="scoring"
      title="Viral-potential score"
      description="An estimate from what StreamHunter measured about each clip (reactions, timing, fit for each platform), never a prediction of views. Weights are relative; the score is the weighted average. High: a strong candidate to upload. Medium: worth reviewing. Low: probably not worth posting. A high score with low confidence (few measurements) shows as medium."
    >
      {(Object.keys(sc.weights) as FactorKey[]).map((k) => (
        <Field key={k} inline label={FACTOR_LABEL[k]} hint={sum ? `${Math.round((sc.weights[k] / sum) * 100)}% of the score` : undefined}>
          {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={sc.weights[k]} min={0} max={100} onCommit={(v) => void update({ scoring: { weights: { [k]: v } } })} />}
        </Field>
      ))}
      <Field inline label="High potential from" hint="Initially 85.">
        {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={sc.highThreshold} min={1} max={100} onCommit={(highThreshold) => void update({ scoring: { highThreshold } })} />}
      </Field>
      <Field inline label="Medium potential from" hint="Below this: low potential.">
        {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={sc.mediumThreshold} min={0} max={99} onCommit={(mediumThreshold) => void update({ scoring: { mediumThreshold } })} />}
      </Field>
    </Section>
  );
}

const ON_DEVICE_TEXT: Record<OnDeviceState, string> = {
  available: "Available on this computer.",
  downloadable: "Supported, but the model isn't downloaded yet (about 22 GB of free disk space needed).",
  downloading: "Downloading the model…",
  unavailable: "Not supported on this computer.",
  absent: "This Chrome has no built-in AI.",
};

/** Optional host permissions are asked for only when you choose a provider. */
async function allowOrigin(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    return await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {
    return false;
  }
}

export function AiSection({ s, update }: V3SectionProps) {
  const ai = s.ai;
  const [state, setState] = useState<OnDeviceState | null>(null);
  const [keys, setKeys] = useState<{ [K in keyof AiKeys]: boolean }>({ anthropic: false, openai_compatible: false });
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const refreshKeys = () => void getAiKeys().then((k) => setKeys({ anthropic: Boolean(k.anthropic), openai_compatible: Boolean(k.openai_compatible) }));
  useEffect(() => {
    void sendRequest({ type: "ai/status" }).then((r) => setState(r.onDevice), () => setState("absent"));
    refreshKeys();
  }, []);
  const provider = ai.external;
  const saveKey = async () => {
    setMsg(null);
    try {
      if (provider === "none") return;
      const origin = provider === "anthropic" ? "https://api.anthropic.com/" : ai.endpoint;
      if (!(await allowOrigin(origin))) throw new Error(`Chrome didn't allow StreamHunter to contact ${new URL(origin).hostname}.`);
      await setAiKey(provider, draft);
      setDraft("");
      setMsg("Key saved on this computer.");
      refreshKeys();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save the key");
    }
  };
  return (
    <Section
      id="ai"
      title="Titles, descriptions and hashtags"
      description="Written from facts StreamHunter has about each clip (creator, platform, game, why it was detected, length). Order: Chrome's on-device AI when available, then your own provider if you set one, then local templates. None is required. Only those facts are sent to a provider, never video."
    >
      <Field inline label="Use on-device AI" hint={state ? ON_DEVICE_TEXT[state] : "Checking…"}>
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Use on-device AI" checked={ai.onDevice} onChange={(onDevice) => void update({ ai: { onDevice } })} />}
      </Field>
      <Field inline label="Your provider" hint={provider === "anthropic" ? "Billed to your Anthropic account. Requests use your key directly from this browser." : provider === "openai_compatible" ? "Any OpenAI-compatible Chat Completions endpoint, e.g. a local model server." : "Off: on-device AI or templates only."}>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} className="w-60" value={provider} onChange={(e) => void update({ ai: { external: e.target.value as Settings["ai"]["external"] } })}>
            <option value="none">None</option>
            <option value="anthropic">Claude (Anthropic API key)</option>
            <option value="openai_compatible">OpenAI-compatible endpoint</option>
          </Select>
        )}
      </Field>
      {provider !== "none" && (
        <>
          {provider === "openai_compatible" && (
            <Field inline label="Endpoint URL" hint="Base URL ending in /v1.">
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} className="w-72" defaultValue={ai.endpoint} placeholder="http://localhost:11434/v1" onBlur={(e) => void update({ ai: { endpoint: e.target.value.trim() } })} />}
            </Field>
          )}
          <Field inline label="Model" hint={provider === "anthropic" ? `Empty = ${DEFAULT_CLAUDE_MODEL}.` : "Required."}>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} className="w-60" defaultValue={ai.model} placeholder={provider === "anthropic" ? DEFAULT_CLAUDE_MODEL : "model name"} onBlur={(e) => void update({ ai: { model: e.target.value.trim() } })} />}
          </Field>
          <Field label="API key" hint={keys[provider] ? "A key is saved (never shown again). Enter a new one to replace it." : provider === "openai_compatible" ? "Optional for local servers." : "Stored only in this browser."}>
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input id={id} aria-describedby={describedBy} type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} className="w-72" placeholder={keys[provider] ? "••••••••" : "Paste your key"} />
                <Button size="sm" variant="secondary" disabled={!draft.trim()} onClick={() => void saveKey()}>
                  Save key
                </Button>
                {keys[provider] && (
                  <Button size="sm" variant="ghost" onClick={() => void setAiKey(provider, null).then(refreshKeys)}>
                    Remove
                  </Button>
                )}
              </div>
            )}
          </Field>
          {msg && <p className="text-xs text-fg-muted">{msg}</p>}
        </>
      )}
      <Field inline label="Credit the creator" hint={'Adds "Credit: <creator> on <platform> <link>" to every generated description.'}>
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Credit the creator" checked={s.metadata.attribution} onChange={(attribution) => void update({ metadata: { attribution } })} />}
      </Field>
    </Section>
  );
}

/** 4.0: automatic editing into vertical Shorts (needs the companion). */
export function EditingSection({ s, update }: V3SectionProps) {
  const e = s.editing;
  return (
    <Section
      id="editing"
      title="Editing"
      description="Turns your best clips into vertical 1080×1920 Shorts on this computer, with the companion and FFmpeg. It crops and stacks the original picture (facecam and the action StreamHunter followed), starts a little before the strongest moment when it comes late, evens out the loudness and, with the motion style, zooms in gently at the strongest moment (Remotion). Nothing is invented and the original clip is never changed: the edited Short is saved as its own version. Landscape (X) versions are never edited."
    >
      <Field inline label="Edit clips">
        {({ id }) => <Switch id={id} label="Edit clips" checked={e.enabled} onChange={(enabled) => void update({ editing: { enabled } })} />}
      </Field>
      <Field inline label="Edit automatically from" hint="Viral-potential score. Initially 85.">
        {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={e.autoFrom} min={1} max={100} onCommit={(autoFrom) => void update({ editing: { autoFrom } })} />}
      </Field>
      <Field inline label="Offer an Edit button from" hint="Initially 70. Below this, clips aren't edited.">
        {({ id, describedBy }) => <NumberField id={id} describedBy={describedBy} value={e.offerFrom} min={0} max={100} onCommit={(offerFrom) => void update({ editing: { offerFrom } })} />}
      </Field>
      <Field inline label="Style" hint="With motion needs Remotion in the companion; without it the Short is made without the zoom.">
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} className="w-60" value={e.style} onChange={(ev) => void update({ editing: { style: ev.target.value as Settings["editing"]["style"] } })}>
            <option value="clean_gaming_motion">Clean gaming with motion (zoom at the peak)</option>
            <option value="clean_gaming">Clean gaming (no motion)</option>
          </Select>
        )}
      </Field>
      <Field inline label="Captions" hint="What is said, from Whisper on this computer (needs the companion with Whisper and the motion style). Only real speech: text over music, noise or silence is dropped. Off by default.">
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Captions" checked={e.captions} onChange={(captions) => void update({ editing: { captions } })} />}
      </Field>
      <Field inline label="Even out loudness" hint="About −14 LUFS, what YouTube and TikTok play at.">
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Even out loudness" checked={e.loudness} onChange={(loudness) => void update({ editing: { loudness } })} />}
      </Field>
      <Field inline label="Encoder" hint="Hardware uses far less CPU and memory; software makes slightly smaller files.">
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} className="w-60" value={e.encoder} onChange={(ev) => void update({ editing: { encoder: ev.target.value as Settings["editing"]["encoder"] } })}>
            <option value="videotoolbox">Hardware (VideoToolbox, Mac)</option>
            <option value="x264">Software (x264)</option>
          </Select>
        )}
      </Field>
      <Field inline label="Wait while recording" hint="Edits start when no stream is being recorded (checked every 5 minutes).">
        {({ id, describedBy }) => <Switch id={id} aria-describedby={describedBy} label="Wait while recording" checked={e.pauseWhileRecording} onChange={(pauseWhileRecording) => void update({ editing: { pauseWhileRecording } })} />}
      </Field>
    </Section>
  );
}

export function V3Sections(props: V3SectionProps) {
  return (
    <>
      <DiscoverySection {...props} />
      <FormatsSection {...props} />
      <ScoringSection {...props} />
      <AiSection {...props} />
      <EditingSection {...props} />
      <CompanionSection />
    </>
  );
}
