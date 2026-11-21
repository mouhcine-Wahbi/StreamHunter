/**
 * Viral-potential score, 0–100 (3.0 phase 6). An estimate from what StreamHunter measured about the
 * clip, never a prediction of views. Six factors with your weights; each says which measurements
 * it used. Confidence drops when inputs are missing, and low confidence never auto-publishes.
 */
import type { Asset } from "@/local/assets";
import type { LocalClip } from "@/local/clips";
import type { Destination } from "@/local/rights";
import type { Settings } from "@/types/settings";

export type FactorKey = "hook" | "emotion" | "engagement" | "story" | "share" | "platform";
export const FACTOR_LABEL: Record<FactorKey, string> = {
  hook: "Hook (first seconds)",
  emotion: "Emotional reaction",
  engagement: "Audience reaction",
  story: "Build-up and payoff",
  share: "Shareability",
  platform: "Platform fit",
};

export interface Factor {
  key: FactorKey;
  points: number;
  weight: number;
  /** Measurements this factor used, in plain words. */
  inputs: string[];
  measured: boolean;
}

export type Tier = "high" | "medium" | "low";
export const TIER_LABEL: Record<Tier, string> = { high: "High potential", medium: "Medium potential", low: "Low potential" };

export interface ClipScore {
  total: number;
  confidence: number;
  tier: Tier;
  factors: Factor[];
  /** Why the tier is what it is, in plain words. */
  summary: string;
  /** Platform fit per destination (the total uses the best one). */
  fitBy: Record<Destination, { points: number; inputs: string[] }>;
  computed_at: string;
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** Platform fit from the made versions: length, layout used, size. */
export function platformFit(dest: Destination, asset: Pick<Asset, "status" | "duration_seconds" | "used_layout" | "width" | "height"> | undefined): { points: number; inputs: string[] } {
  if (!asset || asset.status !== "ready") return { points: 0, inputs: [`No ${dest === "x" ? "landscape" : "vertical"} version yet`] };
  const d = asset.duration_seconds ?? 0;
  const inputs: string[] = [];
  let p: number;
  if (dest === "x") {
    p = d <= 45 ? 90 : d <= 90 ? 75 : d <= 140 ? 55 : 0;
    inputs.push(`${Math.round(d)} s on X (≤ 140 s allowed; shorter tends to work better)`);
  } else {
    p = d >= 15 && d <= 45 ? 95 : d < 15 ? 70 : d <= 60 ? 85 : d <= 180 ? 55 : 0;
    inputs.push(`${Math.round(d)} s vertical (15–45 s is the usual sweet spot)`);
    if (asset.used_layout === "facecam_top" || asset.used_layout === "action") {
      p += 5;
      inputs.push(asset.used_layout === "facecam_top" ? "Facecam above gameplay" : "Crop follows the action");
    } else {
      p -= 10;
      inputs.push("Centre crop: may cut off action at the sides");
    }
  }
  if ((asset.height ?? 0) < 720 && (asset.width ?? 0) < 720) {
    p -= 15;
    inputs.push("Low resolution");
  }
  return { points: clamp(p), inputs };
}

export function scoreClip(
  clip: Pick<LocalClip, "score" | "score_parts" | "confidence" | "event_seconds" | "reasons" | "detection_types" | "duration_seconds" | "peak_at" | "started_at" | "category">,
  assets: Pick<Asset, "kind" | "status" | "duration_seconds" | "used_layout" | "width" | "height">[],
  settings: Settings,
  now = new Date(),
): ClipScore {
  const w = settings.scoring.weights;
  const parts = clip.score_parts ?? null;
  const detected = Boolean(parts);
  const dur = clip.duration_seconds ?? 0;
  const peakOffset = clip.peak_at && clip.started_at ? (Date.parse(clip.peak_at) - Date.parse(clip.started_at)) / 1000 : null;
  const reasons = clip.reasons ?? [];
  const factors: Factor[] = [];

  // Hook: is the strongest moment early enough to hold people from the start?
  {
    const inputs: string[] = [];
    let p = 40;
    let measured = false;
    if (peakOffset !== null && dur > 0) {
      measured = true;
      const frac = peakOffset / dur;
      p = frac <= 0.35 ? 85 : frac <= 0.6 ? 65 : 40;
      inputs.push(`Peak ${Math.round(peakOffset)} s into a ${Math.round(dur)} s clip`);
    } else inputs.push("Peak time not measured");
    if (parts) {
      const strongest = Math.max(parts.audio, parts.chat, parts.visual, parts.viewers);
      p = (p + strongest) / 2;
      inputs.push(`Strongest signal ${Math.round(strongest)}/100`);
    }
    factors.push({ key: "hook", points: clamp(p), weight: w.hook, inputs, measured });
  }

  // Emotion: loud reactions (laughter, screams) and emotional chat.
  {
    const emo = reasons.filter((r) => /laugh|scream|hype|shock|rage|cry|wow|insane|omg|lol|clip it/i.test(r));
    const p = parts ? Math.max(parts.audio, emo.length ? parts.chat : 0) * 0.8 + emo.length * 8 : emo.length * 20;
    factors.push({ key: "emotion", points: clamp(p), weight: w.emotion, inputs: parts ? [`Audio reaction ${Math.round(parts.audio)}/100`, ...emo.slice(0, 2)] : emo.length ? emo.slice(0, 2) : ["No reaction measured"], measured: detected || emo.length > 0 });
  }

  // Engagement: how much the live audience reacted (chat spike, viewers).
  {
    const p = parts ? Math.max(parts.chat, parts.viewers) : 0;
    factors.push({ key: "engagement", points: clamp(p), weight: w.engagement, inputs: parts ? [`Chat reaction ${Math.round(parts.chat)}/100`, `Viewer change ${Math.round(parts.viewers)}/100`] : ["No live audience data (not from a monitored stream)"], measured: detected });
  }

  // Story: build-up before the peak and a payoff after, several signals agreeing.
  {
    const inputs: string[] = [];
    let p = 35;
    if (peakOffset !== null && dur > 0) {
      const before = peakOffset, after = dur - peakOffset;
      p = before >= 4 && after >= 4 ? 70 : 45;
      inputs.push(`${Math.round(before)} s before the peak, ${Math.round(after)} s after`);
    }
    if (clip.event_seconds) {
      inputs.push(`Event lasted ${Math.round(clip.event_seconds)} s`);
      if (clip.event_seconds >= 3) p += 10;
    }
    if (parts && parts.multi > 0) {
      p += 15;
      inputs.push("Several signals agreed");
    }
    factors.push({ key: "story", points: clamp(p), weight: w.story, inputs: inputs.length ? inputs : ["Not measured"], measured: peakOffset !== null || Boolean(clip.event_seconds) });
  }

  // Shareability: kinds of moment people pass on (funny, clutch, fails), chat asking to clip it.
  {
    const kinds = (clip.detection_types ?? []).filter((k) => k !== "manual");
    const sharey = reasons.filter((r) => /clip|funny|laugh|clutch|insane|fail|no shot|crazy/i.test(r));
    const p = 30 + sharey.length * 18 + (kinds.length >= 2 ? 15 : 0) + (clip.category && /funny|clutch|fail/i.test(clip.category) ? 15 : 0);
    factors.push({ key: "share", points: clamp(p), weight: w.share, inputs: sharey.length || kinds.length >= 2 ? [...sharey.slice(0, 2), ...(kinds.length >= 2 ? [`${kinds.length} kinds of signal`] : [])] : ["Nothing suggesting people would share it"], measured: sharey.length > 0 || kinds.length > 0 });
  }

  // Platform fit (best of the destinations; each is shown separately).
  const vertical = assets.find((a) => a.kind === "vertical");
  const landscape = assets.find((a) => a.kind === "landscape");
  const fitBy = { youtube: platformFit("youtube", vertical), tiktok: platformFit("tiktok", vertical), x: platformFit("x", landscape) };
  const best = (Object.entries(fitBy) as [Destination, { points: number; inputs: string[] }][]).sort((a, b) => b[1].points - a[1].points)[0]!;
  const made = vertical?.status === "ready" || landscape?.status === "ready";
  factors.push({ key: "platform", points: best[1].points, weight: w.platform, inputs: made ? best[1].inputs : ["No vertical or landscape version made yet"], measured: made });

  const wsum = factors.reduce((a, f) => a + f.weight, 0) || 1;
  const total = clamp(factors.reduce((a, f) => a + f.points * f.weight, 0) / wsum);
  // Confidence: share of the weight backed by measurements, times the detector's own confidence.
  const measuredShare = factors.filter((f) => f.measured).reduce((a, f) => a + f.weight, 0) / wsum;
  const confidence = Math.round(measuredShare * (clip.confidence ?? (detected ? 0.7 : 0.5)) * 100) / 100;

  const { publishThreshold, reviewThreshold } = settings.scoring;
  let tier: Tier = total >= publishThreshold ? "high" : total >= reviewThreshold ? "medium" : "low";
  let summary =
    tier === "high" ? `${total} ≥ ${publishThreshold}: eligible for automatic publishing when every check passes.` : tier === "medium" ? `${total} is between ${reviewThreshold} and ${publishThreshold}: needs your approval.` : `${total} < ${reviewThreshold}: kept out of automatic publishing; you can still review it.`;
  if (tier === "high" && confidence < 0.5) {
    tier = "medium";
    summary = `${total} ≥ ${publishThreshold}, but confidence is only ${Math.round(confidence * 100)}% (few measurements), so it needs your approval.`;
  }
  return { total, confidence, tier, factors, summary, fitBy, computed_at: now.toISOString() };
}
