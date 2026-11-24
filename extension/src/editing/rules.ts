/**
 * 4.0 automatic editing rules (pure). Which clips are edited, and the edit plan the companion runs.
 * The plan only crops, scales, stacks, trims and normalizes the original picture and sound, using
 * what StreamHunter measured (layout, the "follow the action" path, the strongest moment). Nothing
 * is invented: no captions without real speech, no fake events.
 */
import { cropFor, planVertical, VERTICAL } from "@/processing/layout";
import type { VerticalLayout } from "@/types/api";
import type { Settings } from "@/types/settings";

export const TEMPLATE_CLEAN = "ffmpeg_clean_v1";
export const TEMPLATE_MOTION = "remotion_clean_gaming_v1";
export const TEMPLATE_LABEL: Record<string, string> = { ffmpeg_clean_v1: "Clean gaming (FFmpeg)", remotion_clean_gaming_v1: "Clean gaming with motion (FFmpeg + Remotion)" };
/** A gentle punch-in at the strongest moment (the companion refuses more than 1.15×) and a short fade in. */
export const MOTION = { zoomScale: 1.12, fadeIn: 0.25 } as const;
export const MAX_PATH_POINTS = 48;
/** Opening trim: when the strongest moment comes late, start a few seconds before it. */
export const TRIM = { lateAfter: 14, leadIn: 8, minRemaining: 12 } as const;

export type EditDecision = "auto" | "offer" | "none";

export function decideEdit(score: number | null | undefined, s: Settings["editing"]): EditDecision {
  if (!s.enabled || typeof score !== "number") return "none";
  if (score >= s.autoFrom) return "auto";
  if (score >= s.offerFrom) return "offer";
  return "none";
}

export interface EditPanel {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dy: number;
  dh: number;
  sxPath?: [number, number][];
}
export interface EditPlan {
  version: 1;
  template: string;
  trim: { start: number; end: number | null };
  output: { width: 1080; height: 1920; maxFps: number };
  panels: EditPanel[];
  audio: { loudnorm: boolean };
  encoder: "videotoolbox" | "x264";
  thumbnailAt: number | null;
  /** Remotion template only: zoom at this second of the Short (null: no zoom). */
  motion?: { zoomAt: number | null; zoomScale: number; fadeIn: number };
  /** Remotion template only (4.4): real Whisper speech, in seconds of the Short. */
  captions?: { start: number; end: number; text: string }[];
  notes: string[];
}

export interface EditInput {
  width: number;
  height: number;
  duration: number;
  /** Seconds into the clip of the strongest signal (null when unknown). */
  peakSec: number | null;
  layout: VerticalLayout | null;
  /** [seconds, 0..1] from the vertical version (where the action was). */
  actionPath: [number, number][] | null;
}

/** Same clip + template + options → same key, so it is never edited twice. */
export function dedupeKey(clipId: number, plan: Pick<EditPlan, "template" | "trim" | "audio" | "encoder" | "panels" | "motion" | "captions">): string {
  const opts = JSON.stringify([plan.trim, plan.audio, plan.encoder, plan.panels.map((p) => [p.sx, p.sy, p.sw, p.sh, p.dh, p.sxPath?.length ?? 0]), plan.motion ?? null, plan.captions?.length ?? 0]);
  let h = 5381;
  for (let i = 0; i < opts.length; i++) h = ((h * 33) ^ opts.charCodeAt(i)) >>> 0;
  return `${clipId}:${plan.template}:${h.toString(36)}`;
}

function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

/** Landscape (wider than tall) sources only; vertical 1080×1920 output only. */
export function buildEditPlan(input: EditInput, s: Settings["editing"]): EditPlan | { error: string } {
  if (!input.width || !input.height) return { error: "The clip's size is unknown." };
  if (input.width <= input.height) return { error: "Only landscape recordings are edited into Shorts." };
  const notes: string[] = [];
  const base = planVertical(input.width, input.height, input.layout, 0.5, VERTICAL);
  notes.push(...base.notes);
  const following = base.used !== "center" && input.actionPath && input.actionPath.length > 1;
  const panels: EditPanel[] = base.draws.map((d, i) => {
    const p: EditPanel = { sx: d.sx, sy: d.sy, sw: d.sw, sh: d.sh, dy: d.dy, dh: d.dh };
    // The gameplay window (last panel) follows the action the vertical version measured.
    if (following && i === base.draws.length - 1) {
      p.sxPath = thin(input.actionPath!, MAX_PATH_POINTS).map(([t, x]) => [t, cropFor(input.width, input.height, VERTICAL.width / d.dh, x).sx]);
    }
    return p;
  });
  if (base.used !== "center" && !following) notes.push("No action path was recorded for this clip; the gameplay is centred.");
  let start = 0;
  if (input.peakSec !== null && input.peakSec > TRIM.lateAfter && input.duration - (input.peakSec - TRIM.leadIn) >= TRIM.minRemaining) {
    start = Math.round((input.peakSec - TRIM.leadIn) * 10) / 10;
    notes.push(`Starts ${start.toFixed(1)} s in, ${TRIM.leadIn} s before the strongest moment.`);
  }
  const motion = s.style === "clean_gaming_motion";
  const zoomAt = input.peakSec !== null ? Math.round(Math.max(0, input.peakSec - start) * 10) / 10 : null;
  if (motion) notes.push(zoomAt !== null ? `Zooms in gently at ${zoomAt.toFixed(1)} s (the strongest moment).` : "No strongest moment is known, so there is no zoom.");
  return {
    version: 1,
    template: motion ? TEMPLATE_MOTION : TEMPLATE_CLEAN,
    trim: { start, end: null },
    output: { width: 1080, height: 1920, maxFps: 60 },
    panels,
    audio: { loudnorm: s.loudness },
    encoder: s.encoder,
    thumbnailAt: input.peakSec !== null ? Math.max(0, input.peakSec - start) : null,
    ...(motion ? { motion: { zoomAt, zoomScale: MOTION.zoomScale, fadeIn: MOTION.fadeIn } } : {}),
    notes,
  };
}
