import {
  DEFAULT_SETTINGS,
  LIMITS,
  SUPPORTED_KEYWORD_LANGUAGES,
  type AspectRatio,
  type DeepPartial,
  type Sensitivity,
  type Settings,
} from "@/types/settings";

const SENSITIVITIES: readonly Sensitivity[] = ["low", "medium", "high"];
const RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1"];
const LANG_CODES = new Set<string>(SUPPORTED_KEYWORD_LANGUAGES.map((l) => l.code));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function normalizeBackendUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null; // never store credentials in URLs
    // Plain http is only acceptable for a local development backend.
    if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return null;
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return null;
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (tz === "auto") return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function sanitizeKeywords(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const k = item.trim().slice(0, LIMITS.customKeywords.maxLength);
    const key = k.toLocaleLowerCase();
    if (!k || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= LIMITS.customKeywords.maxItems) break;
  }
  return out;
}

/**
 * Turns any stored/untrusted value into a complete, valid Settings object.
 * Unknown keys are dropped; invalid values fall back to defaults.
 */
export function sanitizeSettings(input: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const s = isRecord(input) ? input : {};
  const mon = isRecord(s.monitoring) ? s.monitoring : {};
  const det = isRecord(s.detection) ? s.detection : {};
  const clips = isRecord(s.clips) ? s.clips : {};
  const notif = isRecord(s.notifications) ? s.notifications : {};
  const loc = isRecord(s.locale) ? s.locale : {};
  const priv = isRecord(s.privacy) ? s.privacy : {};

  const langs = Array.isArray(det.keywordLanguages)
    ? det.keywordLanguages.filter((c): c is string => typeof c === "string" && LANG_CODES.has(c))
    : d.detection.keywordLanguages;

  const tz = typeof loc.timeZone === "string" && isValidTimeZone(loc.timeZone) ? loc.timeZone : d.locale.timeZone;

  return {
    backendUrl: normalizeBackendUrl(s.backendUrl) ?? d.backendUrl,
    monitoring: {
      intervalMinutes: clampInt(
        mon.intervalMinutes,
        LIMITS.intervalMinutes.min,
        LIMITS.intervalMinutes.max,
        d.monitoring.intervalMinutes,
      ),
      resumeOnStartup: bool(mon.resumeOnStartup, d.monitoring.resumeOnStartup),
    },
    detection: {
      sensitivity: oneOf(det.sensitivity, SENSITIVITIES, d.detection.sensitivity),
      minHighlightScore: clampInt(
        det.minHighlightScore,
        LIMITS.minHighlightScore.min,
        LIMITS.minHighlightScore.max,
        d.detection.minHighlightScore,
      ),
      keywordLanguages: Array.from(new Set(langs)),
      customKeywords: sanitizeKeywords(det.customKeywords),
    },
    clips: {
      preRollSeconds: clampInt(clips.preRollSeconds, LIMITS.rollSeconds.min, LIMITS.rollSeconds.max, d.clips.preRollSeconds),
      postRollSeconds: clampInt(
        clips.postRollSeconds,
        LIMITS.rollSeconds.min,
        LIMITS.rollSeconds.max,
        d.clips.postRollSeconds,
      ),
      defaultAspectRatio: oneOf(clips.defaultAspectRatio, RATIOS, d.clips.defaultAspectRatio),
    },
    notifications: {
      onHighlight: bool(notif.onHighlight, d.notifications.onHighlight),
      onStreamerLive: bool(notif.onStreamerLive, d.notifications.onStreamerLive),
    },
    locale: {
      timeZone: tz,
      language: typeof loc.language === "string" && loc.language.length <= 10 ? loc.language : d.locale.language,
    },
    privacy: {
      retentionDays: clampInt(
        priv.retentionDays,
        LIMITS.retentionDays.min,
        LIMITS.retentionDays.max,
        d.privacy.retentionDays,
      ),
    },
  };
}

/** Deep-merges a patch into settings (arrays are replaced) and re-sanitizes the result. */
export function mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isRecord(a) || !isRecord(b)) return b === undefined ? a : b;
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  };
  return sanitizeSettings(merge(current, patch));
}
