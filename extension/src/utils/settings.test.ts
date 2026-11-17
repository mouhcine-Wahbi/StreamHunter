import { DEFAULT_SETTINGS } from "@/types/settings";
import { mergeSettings, sanitizeSettings } from "./settings";
import { backoffDelayMs } from "./backoff";

describe("sanitizeSettings", () => {
  it("returns defaults for missing or garbage input", () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ monitoring: [] })).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps numbers and rejects invalid enums", () => {
    const s = sanitizeSettings({
      monitoring: { intervalMinutes: 0.2 },
      detection: { minHighlightScore: 500, sensitivity: "extreme", keywordLanguages: ["en", "xx", "fr", "fr"] },
      clips: { preRollSeconds: -5, defaultAspectRatio: "4:3" },
      privacy: { retentionDays: "7" },
    });
    expect(s.monitoring.intervalMinutes).toBe(1);
    expect(s.detection.minHighlightScore).toBe(100);
    expect(s.detection.sensitivity).toBe("medium");
    expect(s.detection.keywordLanguages).toEqual(["en", "fr"]);
    expect(s.clips.preRollSeconds).toBe(0);
    expect(s.privacy.retentionDays).toBe(7);
  });

  it("dedupes and bounds custom keywords", () => {
    const s = sanitizeSettings({ detection: { customKeywords: ["Clip it", "clip it", "  ", 3, "x".repeat(80)] } });
    expect(s.detection.customKeywords).toEqual(["Clip it", "x".repeat(40)]);
  });

  it("rejects invalid time zones", () => {
    expect(sanitizeSettings({ locale: { timeZone: "Mars/Olympus" } }).locale.timeZone).toBe("auto");
    expect(sanitizeSettings({ locale: { timeZone: "Europe/Paris" } }).locale.timeZone).toBe("Europe/Paris");
  });
});

describe("mergeSettings", () => {
  it("deep merges a patch and keeps other values", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { detection: { sensitivity: "high" } });
    expect(next.detection.sensitivity).toBe("high");
    expect(next.detection.minHighlightScore).toBe(DEFAULT_SETTINGS.detection.minHighlightScore);
    expect(next.monitoring).toEqual(DEFAULT_SETTINGS.monitoring);
  });
  it("replaces arrays rather than concatenating", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { detection: { keywordLanguages: ["es"] } });
    expect(next.detection.keywordLanguages).toEqual(["es"]);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1, { baseMs: 1000, maxMs: 10_000 })).toBe(1000);
    expect(backoffDelayMs(3, { baseMs: 1000, maxMs: 10_000 })).toBe(4000);
    expect(backoffDelayMs(10, { baseMs: 1000, maxMs: 10_000 })).toBe(10_000);
  });
});
