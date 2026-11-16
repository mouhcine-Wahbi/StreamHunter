import { FLOOR_DB, LoudnessMeter } from "./loudness";

const at = new Date("2026-11-16T12:00:00Z");

describe("loudness meter", () => {
  it("reports RMS in dBFS per call and resets", () => {
    const m = new LoudnessMeter();
    expect(m.take(at)).toBeNull(); // no audio yet
    const sine = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
    m.add(sine.subarray(0, 2400));
    m.add(sine.subarray(2400));
    expect(m.take(at)).toEqual({ t: "2026-11-16T12:00:00.000Z", db: -3 }); // full-scale sine ≈ −3 dB
    expect(m.take(at)).toBeNull();
    m.add(sine.map((v) => v * 0.1));
    expect(m.take(at)?.db).toBe(-23); // 20 dB quieter
  });

  it("reports silence as the floor", () => {
    const m = new LoudnessMeter();
    m.add(new Float32Array(1024));
    expect(m.take(at)?.db).toBe(FLOOR_DB);
  });
});
