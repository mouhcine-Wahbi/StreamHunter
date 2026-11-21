/**
 * Output geometry (3.0 phase 5). Pure functions, no media APIs, so every rule is unit-tested:
 * - Vertical 9:16 (YouTube Shorts, TikTok): facecam above gameplay, follow the action, centre crop.
 * - Landscape (X): the original frame scaled to fit X's limits, never cropped.
 */
import type { Rect, VerticalLayout } from "@/types/api";

export type LayoutKind = VerticalLayout["kind"];
export const LAYOUT_LABEL: Record<LayoutKind, string> = { facecam_top: "Facecam above gameplay", action: "Follow the action", center: "Centre crop" };

export const VERTICAL = { width: 1080, height: 1920 } as const;

/**
 * Limits StreamHunter keeps X versions within: 140 s, 1920×1200, H.264 + AAC, 512 MB. These are
 * stricter than X requires for posts (X's media docs, checked 2026-11-21: tweet_video up to 20 min
 * and 8 GB without Premium; 140 s / 512 MB is the dm_video limit), so they fit every account.
 */
export const X_LIMITS = { maxSeconds: 140, maxWidth: 1920, maxHeight: 1200, maxBytes: 512 * 1024 ** 2 } as const;

/** One source rectangle drawn into one destination rectangle (pixels). */
export interface Draw {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface Plan {
  width: number;
  height: number;
  draws: Draw[];
  /** The layout actually used (facecam_top without a facecam rectangle falls back to centre). */
  used: LayoutKind;
  notes: string[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The largest rectangle of aspect `aspect` (w/h) inside srcW×srcH, horizontally centred on `cx` (0..1). */
export function cropFor(srcW: number, srcH: number, aspect: number, cx = 0.5, region: { y: number; h: number } = { y: 0, h: srcH }): Omit<Draw, "dx" | "dy" | "dw" | "dh"> {
  let sh = region.h;
  let sw = sh * aspect;
  if (sw > srcW) {
    sw = srcW;
    sh = sw / aspect;
  }
  // Round the size first, then place it, so the window never reaches past the frame edge.
  const w = Math.min(srcW, Math.round(sw));
  const h = Math.min(region.h, Math.round(sh));
  const sx = Math.round(clamp(cx * srcW - w / 2, 0, srcW - w));
  const sy = Math.round(region.y + (region.h - h) / 2);
  return { sx, sy, sw: w, sh: h };
}

/**
 * The vertical 9:16 frame for one source frame.
 * - facecam_top: the facecam (as set for the creator) fills the top, scaled to the full width, up
 *   to 40% of the height; the gameplay fills the rest, cropped around the centre (or `actionX`).
 * - action: a 9:16 window that follows `actionX` (0..1, from {@link ActionTracker}).
 * - center: a centred 9:16 window.
 */
export function planVertical(srcW: number, srcH: number, layout: VerticalLayout | null | undefined, actionX = 0.5, out: { width: number; height: number } = VERTICAL): Plan {
  const W = out.width;
  const H = out.height;
  const notes: string[] = [];
  const kind: LayoutKind = layout?.kind ?? "center";
  const face: Rect | null | undefined = layout?.facecam;
  if (kind === "facecam_top" && face && face.w > 0 && face.h > 0) {
    const fx = face.x * srcW, fy = face.y * srcH, fw = face.w * srcW, fh = face.h * srcH;
    // Facecam scaled to full width; capped at 40% of the height (cropped to fit when taller).
    let camH = Math.round((W * fh) / fw);
    let camCrop = { sx: fx, sy: fy, sw: fw, sh: fh };
    const maxCam = Math.round(H * 0.4);
    if (camH > maxCam) {
      camH = maxCam;
      const c = cropFor(fw, fh, W / camH);
      camCrop = { sx: fx + c.sx, sy: fy + c.sy, sw: c.sw, sh: c.sh };
    }
    camH = even(camH);
    const gameH = H - camH;
    const game = cropFor(srcW, srcH, W / gameH, actionX);
    return {
      width: W,
      height: H,
      used: "facecam_top",
      notes,
      draws: [
        { ...roundDraw(camCrop), dx: 0, dy: 0, dw: W, dh: camH },
        { ...game, dx: 0, dy: camH, dw: W, dh: gameH },
      ],
    };
  }
  if (kind === "facecam_top") notes.push("No facecam position is set for this creator, so the centre crop was used.");
  const used: LayoutKind = kind === "action" ? "action" : "center";
  const crop = cropFor(srcW, srcH, W / H, used === "action" ? actionX : 0.5);
  return { width: W, height: H, used, notes, draws: [{ ...crop, dx: 0, dy: 0, dw: W, dh: H }] };
}

function roundDraw(r: { sx: number; sy: number; sw: number; sh: number }) {
  return { sx: Math.round(r.sx), sy: Math.round(r.sy), sw: Math.round(r.sw), sh: Math.round(r.sh) };
}

/** Landscape for X: the whole frame, scaled down (never up) to fit 1920×1200, even dimensions. */
export function planLandscape(srcW: number, srcH: number): Plan {
  const scale = Math.min(1, X_LIMITS.maxWidth / srcW, X_LIMITS.maxHeight / srcH);
  const w = even(srcW * scale);
  const h = even(srcH * scale);
  return { width: w, height: h, used: "center", notes: [], draws: [{ sx: 0, sy: 0, sw: srcW, sh: srcH, dx: 0, dy: 0, dw: w, dh: h }] };
}

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  sizeBytes: number;
}

/** Why a file can't go to X as it is (empty = it can be reused without re-encoding). */
export function xProblems(m: MediaInfo): string[] {
  const p: string[] = [];
  if (m.durationSec > X_LIMITS.maxSeconds) p.push(`longer than ${X_LIMITS.maxSeconds} s`);
  if (m.width > X_LIMITS.maxWidth || m.height > X_LIMITS.maxHeight) p.push(`larger than ${X_LIMITS.maxWidth}×${X_LIMITS.maxHeight}`);
  if (!/^avc1/.test(m.videoCodec)) p.push("video isn't H.264");
  if (m.audioCodec && !/^mp4a/.test(m.audioCodec)) p.push("audio isn't AAC");
  if (m.sizeBytes > X_LIMITS.maxBytes) p.push("larger than 512 MB");
  return p;
}

/**
 * Follows the action for the "follow the action" crop: where the picture changes most, smoothed so
 * the window glides instead of jumping. Input per frame: motion energy per column (any count),
 * from a small downscaled difference image. Pure and deterministic.
 */
export class ActionTracker {
  private x = 0.5;
  private started = false;
  constructor(
    private readonly opts = {
      /** Fraction of the remaining distance moved per frame. */
      smoothing: 0.08,
      /** Largest move per frame (fraction of the width). */
      maxStep: 0.012,
      /** Ignore targets this close to the current position. */
      deadZone: 0.06,
      /** Below this share of total energy in the busiest third, keep still (noise, fades). */
      minFocus: 0.42,
    },
  ) {}

  get position(): number {
    return this.x;
  }

  update(columns: ArrayLike<number>): number {
    const n = columns.length;
    let total = 0;
    let weighted = 0;
    for (let i = 0; i < n; i++) {
      total += columns[i]!;
      weighted += columns[i]! * ((i + 0.5) / n);
    }
    if (total <= 0 || n === 0) return this.x;
    const target = weighted / total;
    // How concentrated is the motion around the target? Spread-out motion (camera pans, cuts) → stay.
    const lo = Math.floor(clamp(target - 1 / 6, 0, 1) * n);
    const hi = Math.ceil(clamp(target + 1 / 6, 0, 1) * n);
    let near = 0;
    for (let i = lo; i < hi; i++) near += columns[i]!;
    if (near / total < this.opts.minFocus) return this.x;
    if (!this.started) {
      this.started = true;
      this.x = target;
      return this.x;
    }
    const d = target - this.x;
    if (Math.abs(d) < this.opts.deadZone) return this.x;
    this.x += clamp(d * this.opts.smoothing, -this.opts.maxStep, this.opts.maxStep);
    return this.x;
  }
}

/** Column motion energy from two grayscale frames (row-major, same size). */
export function columnEnergy(prev: ArrayLike<number>, cur: ArrayLike<number>, width: number, height: number, threshold = 18): Float32Array {
  const out = new Float32Array(width);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const d = Math.abs(cur[i]! - prev[i]!);
      if (d > threshold) out[x]! += d;
    }
  return out;
}

/**
 * Which vertical layout a clip gets: your choice for this clip, else the creator's saved layout,
 * else the default from Settings (facecam above gameplay uses the creator's facecam position).
 */
export function resolveLayout(
  override: VerticalLayout | null | undefined,
  creator: VerticalLayout | null | undefined,
  defaultKind: LayoutKind,
): { layout: VerticalLayout; source: "clip" | "creator" | "default" } {
  const withFace = (kind: LayoutKind): VerticalLayout => ({ kind, facecam: kind === "facecam_top" ? (creator?.facecam ?? null) : null });
  if (override) return { layout: override.kind === "facecam_top" && !override.facecam ? withFace("facecam_top") : override, source: "clip" };
  if (creator) return { layout: creator, source: "creator" };
  return { layout: withFace(defaultKind), source: "default" };
}
