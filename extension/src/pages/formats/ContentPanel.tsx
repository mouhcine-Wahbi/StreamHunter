/**
 * A clip's viral-potential score (with the reasons) and its title, description and hashtags per
 * destination, editable. Shown under each clip on Short-form Clips (YouTube, TikTok) and X Clips (X).
 */
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useApiClient } from "@/hooks/useApiQuery";
import { sendRequest } from "@/services/runtime";
import type { ContentClip } from "@/local/content";
import type { Destination } from "@/local/rights";
import { GENERATOR_LABEL, LIMITS, xLength, type DestinationMeta } from "@/metadata/metadata";
import { FACTOR_LABEL, TIER_LABEL, type ClipScore, type Tier } from "@/scoring/score";

const TIER_TONE: Record<Tier, BadgeTone> = { high: "live", medium: "accent", low: "neutral" };
const DEST_LABEL: Record<Destination, string> = { youtube: "YouTube Shorts", tiktok: "TikTok", x: "X" };

export function ScoreView({ score }: { score: ClipScore }) {
  return (
    <details className="rounded-md border border-border p-2">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <Badge tone={TIER_TONE[score.tier]}>{TIER_LABEL[score.tier]}</Badge>
        <span className="font-medium text-fg">{score.total}/100</span>
        <span className="text-fg-subtle">confidence {Math.round(score.confidence * 100)}%</span>
      </summary>
      <p className="mt-2 text-fg-muted">{score.summary}</p>
      <p className="text-fg-subtle">An estimate from what was measured about this clip, not a prediction of views.</p>
      <ul className="mt-2 space-y-1">
        {score.factors.map((f) => (
          <li key={f.key}>
            <span className="font-medium text-fg">{FACTOR_LABEL[f.key]}</span> {f.points}/100 · weight {f.weight}
            {!f.measured && <span className="text-warn"> · not measured</span>}
            <span className="block text-fg-subtle">{f.inputs.join(" · ")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function MetaEditor({ clip, dest, meta, edited, onSaved }: { clip: ContentClip; dest: Destination; meta: DestinationMeta; edited: boolean; onSaved: () => void }) {
  const client = useApiClient();
  const [title, setTitle] = useState(meta.title);
  const [text, setText] = useState(meta.description);
  const [tags, setTags] = useState(meta.hashtags.join(" "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const L = LIMITS[dest];
  const draft: DestinationMeta = { title, description: text, hashtags: tags.split(/[\s,]+/).filter(Boolean) };
  const dirty = title !== meta.title || text !== meta.description || tags !== meta.hashtags.join(" ");
  const len = dest === "x" ? xLength(draft) : text.length;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await client.patch(`/api/v1/clips/${clip.id}/metadata/${dest}`, draft);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };
  const id = `meta-${clip.id}-${dest}`;
  return (
    <fieldset className="space-y-1 rounded-md border border-border p-2">
      <legend className="px-1 font-medium text-fg">
        {DEST_LABEL[dest]}
        {edited && <span className="text-fg-subtle"> · edited by you</span>}
      </legend>
      {L.title > 0 && (
        <label className="block">
          <span className="text-fg-subtle">Title ({title.length}/{L.title})</span>
          <Input id={`${id}-title`} value={title} maxLength={L.title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      )}
      <label className="block">
        <span className="text-fg-subtle">
          {dest === "youtube" ? "Description" : dest === "tiktok" ? "Caption" : "Post"} ({len}/{L.text}
          {dest === "x" ? ", links count as 23, hashtags included" : ""})
        </span>
        <textarea id={`${id}-text`} value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-md border border-border bg-bg p-2 text-xs text-fg" />
      </label>
      <label className="block">
        <span className="text-fg-subtle">Hashtags (up to {L.hashtags}, separated by spaces)</span>
        <Input id={`${id}-tags`} value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      {len > L.text && <p className="text-warn">Too long: it will be shortened when saved.</p>}
      {err && <p className="text-danger">{err}</p>}
      <Button size="sm" variant="secondary" disabled={!dirty} loading={busy} onClick={() => void save()}>
        Save {DEST_LABEL[dest]} text
      </Button>
    </fieldset>
  );
}

export function ContentPanel({ clip, dests, onChanged }: { clip: ContentClip; dests: Destination[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const md = clip.metadata;
  const generate = async (resetEdits: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await sendRequest({ type: "metadata/generate", clipId: clip.id, resetEdits });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not write the text");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {clip.viral && <ScoreView score={clip.viral} />}
      <details className="rounded-md border border-border p-2">
        <summary className="cursor-pointer">
          <span className="font-medium text-fg">Title, text and hashtags</span>
          {md ? <span className="text-fg-subtle"> · {GENERATOR_LABEL[md.generator]}</span> : <span className="text-fg-subtle"> · not written yet</span>}
        </summary>
        <div className="mt-2 space-y-2">
          {md?.fallbacks.length ? <p className="text-fg-subtle">Why not an earlier option: {md.fallbacks.join(" ")}</p> : null}
          {md &&
            dests.map((d) => (
              <MetaEditor key={`${d}-${md.generated_at}-${md.edited.includes(d)}-${md.byDestination[d].description}`} clip={clip} dest={d} meta={md.byDestination[d]} edited={md.edited.includes(d)} onSaved={onChanged} />
            ))}
          {err && <p className="text-danger">{err}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} loading={busy} onClick={() => void generate(false)}>
              {md ? "Write again (keeps your edits)" : "Write now"}
            </Button>
            {md && md.edited.length > 0 && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void generate(true)}>
                Write again, replacing your edits
              </Button>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
