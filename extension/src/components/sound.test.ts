import { describe, expect, it } from "vitest";
import { heardLabel } from "@/components/highlights/HighlightRow";
import { soundSummary } from "@/components/monitoring/SessionMedia";

describe("laughter / cheering / screaming display", () => {
  it("summarises what the analysis heard", () => {
    expect(soundSummary({ sound_classification: "done", sound_events: { laughter: 2, cheering: 0, screaming: 1 } })).toEqual({
      text: "Heard: 2 laughter · 1 screaming",
      warn: false,
    });
    expect(soundSummary({ sound_classification: "done", sound_events: {} })?.text).toBe("No laughter, cheering or screaming heard");
    expect(soundSummary({ sound_classification: "failed: Could not download the sound model" })).toEqual({
      text: "Sound detection skipped: Could not download the sound model",
      warn: true,
    });
    expect(soundSummary({ sound_classification: "not_installed" })?.text).toMatch(/isn't installed/);
    expect(soundSummary({ sound_classification: "no_audio" })).toBeNull();
    expect(soundSummary({})).toBeNull(); // results from before sound detection existed
  });

  it("names a highlight's clearest sound only when it is clear", () => {
    expect(heardLabel({ laughter: 0.8, cheering: 0.5, screaming: 0.01 })).toBe("laughter 80%");
    expect(heardLabel({ laughter: 0.3, cheering: 0.2 })).toBeNull();
    expect(heardLabel(null)).toBeNull();
    expect(heardLabel(undefined)).toBeNull();
  });
});
