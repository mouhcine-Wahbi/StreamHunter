/**
 * StreamHunter 3.0 settings: content discovery, output formats, scoring, publishing and AI.
 * Each section only edits its own part of the settings; everything is sanitized on save.
 */
import { Field, Input, Select } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { YT_CATEGORIES } from "@/discovery/runner";
import type { DeepPartial, Settings } from "@/types/settings";
import { KeywordEditor, NumberField, Section } from "./sections";

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

export function V3Sections(props: V3SectionProps) {
  return (
    <>
      <DiscoverySection {...props} />
      <FormatsSection {...props} />
    </>
  );
}
