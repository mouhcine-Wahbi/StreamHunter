import {
  DEFAULT_SETTINGS,
  LIMITS,
  SUPPORTED_KEYWORD_LANGUAGES,
  type DeepPartial,
  type Sensitivity,
  type Settings,
} from "@/types/settings";

const SENSITIVITIES: readonly Sensitivity[] = ["low", "medium", "high"];
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
  const store = isRecord(s.storage) ? s.storage : {};
  const rec = isRecord(s.recording) ? s.recording : {};
  const sch = isRecord(s.scheduler) ? s.scheduler : {};
  const sw = isRecord(sch.weights) ? sch.weights : {};
  const sweight = (k: keyof Settings["scheduler"]["weights"]) => clampInt(sw[k], 0, 100, d.scheduler.weights[k]);
  const w = isRecord(det.weights) ? det.weights : {};
  const weight = (k: keyof Settings["detection"]["weights"]) => clampInt(w[k], LIMITS.weight.min, LIMITS.weight.max, d.detection.weights[k]);

  const langs = Array.isArray(det.keywordLanguages)
    ? det.keywordLanguages.filter((c): c is string => typeof c === "string" && LANG_CODES.has(c))
    : d.detection.keywordLanguages;

  const tz = typeof loc.timeZone === "string" && isValidTimeZone(loc.timeZone) ? loc.timeZone : d.locale.timeZone;

  return {
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
      weights: { audio: weight("audio"), chat: weight("chat"), visual: weight("visual"), viewers: weight("viewers"), multi: weight("multi") },
      clipThreshold: clampInt(det.clipThreshold, 0, 100, d.detection.clipThreshold),
    },
    clips: {
      preRollSeconds: clampInt(clips.preRollSeconds, LIMITS.rollSeconds.min, LIMITS.rollSeconds.max, d.clips.preRollSeconds),
      postRollSeconds: clampInt(
        clips.postRollSeconds,
        LIMITS.rollSeconds.min,
        LIMITS.rollSeconds.max,
        d.clips.postRollSeconds,
      ),
      bufferSeconds: clampInt(clips.bufferSeconds, LIMITS.bufferSeconds.min, LIMITS.bufferSeconds.max, d.clips.bufferSeconds),
      maxClipSeconds: clampInt(clips.maxClipSeconds, LIMITS.maxClipSeconds.min, LIMITS.maxClipSeconds.max, d.clips.maxClipSeconds),
      twitchNativeClips: bool(clips.twitchNativeClips, d.clips.twitchNativeClips),
    },
    scheduler: {
      weights: { potential: sweight("potential"), activity: sweight("activity"), growth: sweight("growth"), user: sweight("user"), reliability: sweight("reliability") },
      minRecordMinutes: clampInt(sch.minRecordMinutes, LIMITS.minRecordMinutes.min, LIMITS.minRecordMinutes.max, d.scheduler.minRecordMinutes),
      cooldownMinutes: clampInt(sch.cooldownMinutes, LIMITS.cooldownMinutes.min, LIMITS.cooldownMinutes.max, d.scheduler.cooldownMinutes),
      switchMargin: clampInt(sch.switchMargin, LIMITS.switchMargin.min, LIMITS.switchMargin.max, d.scheduler.switchMargin),
      maxRetries: clampInt(sch.maxRetries, LIMITS.maxRetries.min, LIMITS.maxRetries.max, d.scheduler.maxRetries),
    },
    recording: {
      maxStreams: clampInt(rec.maxStreams, LIMITS.maxStreams.min, LIMITS.maxStreams.max, d.recording.maxStreams),
      quality: oneOf(rec.quality, ["720p", "480p"] as const, d.recording.quality),
      audio: oneOf(rec.audio, ["first", "none"] as const, d.recording.audio),
      protectResources: bool(rec.protectResources, d.recording.protectResources),
    },
    storage: {
      maxTotalMb: clampInt(store.maxTotalMb, LIMITS.maxTotalMb.min, LIMITS.maxTotalMb.max, d.storage.maxTotalMb),
      maxAgeDays: clampInt(store.maxAgeDays, LIMITS.maxAgeDays.min, LIMITS.maxAgeDays.max, d.storage.maxAgeDays),
    },
    notifications: {
      onHighlight: bool(notif.onHighlight, d.notifications.onHighlight),
      onStreamerLive: bool(notif.onStreamerLive, d.notifications.onStreamerLive),
      approvalRequests: bool(notif.approvalRequests, d.notifications.approvalRequests),
      remindMinutes: clampInt(notif.remindMinutes, 1, 120, d.notifications.remindMinutes),
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
