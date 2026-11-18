import { ChunkRing } from "./buffer";
import { muxMp4 } from "./mux";
import { AudioFeatureMeter, LiveSignals, rhythmScore } from "./signals";

const T = 1_000_000;
/** 30 fps video with a keyframe every 2 s, and 48 kHz AAC frames (~21.3 ms). */
function feed(ring: ChunkRing, seconds: number, start = T) {
  for (let i = 0; i < seconds * 30; i++) ring.push({ kind: "video", key: i % 60 === 0, at: start + (i * 1000) / 30, duration: 1000 / 30, data: new Uint8Array([0, 0, 0, 1, i % 255]) });
  for (let i = 0; i < seconds * 47; i++) ring.push({ kind: "audio", key: true, at: start + i * 21.33, duration: 21.33, data: new Uint8Array([0x21, i % 255]) });
}

describe("capture rolling buffer", () => {
  it("keeps about the last N seconds, starting at a keyframe", () => {
    const ring = new ChunkRing(120_000);
    feed(ring, 200);
    const span = ring.newest! - ring.oldest!;
    expect(span).toBeGreaterThanOrEqual(120_000 - 40);
    expect(span).toBeLessThanOrEqual(122_000);
    expect(ring.select(ring.oldest!, ring.oldest! + 1000)!.video[0]!.key).toBe(true);
  });

  it("cuts a clip from the keyframe at or before its start", () => {
    const ring = new ChunkRing(120_000);
    feed(ring, 60);
    const sel = ring.select(T + 25_500, T + 40_000)!;
    expect(sel.video[0]).toMatchObject({ key: true, at: T + 24_000 });
    expect(sel.from).toBe(T + 24_000);
    expect(sel.to).toBeCloseTo(T + 40_000 + 1000 / 30, 0);
    expect(sel.audio.length).toBeGreaterThan(16 * 40);
    expect(sel.audio.every((a) => a.at + a.duration > sel.from && a.at < sel.to)).toBe(true);
    expect(ring.select(T + 100_000, T + 110_000)).not.toBeNull(); // past the end: up to what exists
    expect(new ChunkRing(1000).select(T, T + 1)).toBeNull();
  });
});

const bytes = (b: Blob) =>
  new Promise<Uint8Array>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.readAsArrayBuffer(b);
  });

describe("MP4 output", () => {
  it("muxes encoded chunks into an MP4 file without re-encoding", async () => {
    const ring = new ChunkRing(120_000);
    feed(ring, 6);
    const sel = ring.select(T, T + 5000)!;
    const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0, 0, 0]);
    const blob = muxMp4(sel.video, sel.audio, {
      video: { width: 1280, height: 720, decoderConfig: { codec: "avc1.640028", codedWidth: 1280, codedHeight: 720, description: avcC } },
      audio: { codec: "aac", sampleRate: 48000, numberOfChannels: 2, decoderConfig: { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) } },
    });
    expect(blob.type).toBe("video/mp4");
    const head = new TextDecoder().decode((await bytes(blob)).slice(4, 8));
    expect(head).toBe("ftyp");
    const text = new TextDecoder("latin1").decode(await bytes(blob));
    expect(text).toContain("moov");
    expect(text).toContain("avc1");
    expect(text).toContain("mp4a");
  });
});

describe("live signals from a capture", () => {
  const flat = (db: number) => Array.from({ length: 20 }, () => db);
  function steady(s: LiveSignals, seconds: number, from: number, db = -30, motion = 3, brightness = 100, zcr = 0.05) {
    for (let i = 0; i < seconds; i++) s.add({ t: from + i * 1000, db, motion, brightness, zcr, envelope: flat(db), cuts: 0 });
  }

  it("finds loud moments, fast action and flashes against the stream's own normal", () => {
    const s = new LiveSignals();
    steady(s, 60, T);
    expect(s.detect(T + 59_000)).toEqual([]);
    steady(s, 3, T + 60_000, -14); // 16 dB louder
    expect(s.detect(T + 62_000)).toEqual([{ kind: "audio", at: T + 62_000, intensity: 89, reasons: ["Stream audio 16 dB louder than usual"] }]);

    const v = new LiveSignals();
    steady(v, 60, T);
    steady(v, 3, T + 60_000, -30, 12);
    expect(v.detect(T + 62_000)).toEqual([{ kind: "visual", at: T + 62_000, intensity: 100, reasons: ["Fast on-screen action (4.0× the usual motion)"] }]);

    const f = new LiveSignals();
    steady(f, 60, T);
    f.add({ t: T + 60_000, db: -30, motion: 3, brightness: 100 });
    f.add({ t: T + 61_000, db: -30, motion: 3, brightness: 220 });
    f.add({ t: T + 62_000, db: -30, motion: 3, brightness: 105 });
    expect(f.detect(T + 62_000)).toMatchObject([{ kind: "visual", reasons: ["Sudden flash on screen"], intensity: 50 }]);
  });

  it("recognises shouting-like, cheer-like and laughter-like sound, sudden bursts and rapid scene cuts", () => {
    const shout = new LiveSignals();
    steady(shout, 60, T);
    for (let i = 0; i < 3; i++) shout.add({ t: T + 60_000 + i * 1000, db: -18, motion: 3, brightness: 100, zcr: 0.12, envelope: [-18, -25, -16, -30, -18, -24, -17, -29, -18, -25, -16, -30, -18, -25, -16, -28, -18, -26, -17, -29] });
    expect(shout.detect(T + 62_000)[0]!.reasons).toContain("Shouting/screaming-like sound");

    const cheer = new LiveSignals();
    steady(cheer, 60, T);
    steady(cheer, 4, T + 60_000, -20, 3, 100, 0.15);
    expect(cheer.detect(T + 63_000)[0]!.reasons).toEqual(["Stream audio 10 dB louder than usual", "Crowd/cheer-like noise"]);

    const laugh = new LiveSignals();
    steady(laugh, 60, T);
    const pulse = Array.from({ length: 20 }, (_, i) => (i % 4 < 2 ? -18 : -32)); // 5 pulses a second
    for (let i = 0; i < 3; i++) laugh.add({ t: T + 60_000 + i * 1000, db: -22, motion: 3, brightness: 100, zcr: 0.05, envelope: pulse });
    const l = laugh.detect(T + 62_000)[0]!;
    expect(l.reasons).toContain("Laughter-like rhythmic bursts");
    expect(l.intensity).toBeGreaterThanOrEqual(60);

    const burst = new LiveSignals();
    steady(burst, 62, T);
    burst.add({ t: T + 62_000, db: -12, motion: 3, brightness: 100, zcr: 0.05, envelope: flat(-12) });
    expect(burst.detect(T + 62_000)[0]!.reasons).toContain("Sudden burst of sound");

    const cuts = new LiveSignals();
    steady(cuts, 60, T);
    for (let i = 0; i < 3; i++) cuts.add({ t: T + 60_000 + i * 1000, db: -30, motion: 3, brightness: 100, zcr: 0.05, envelope: flat(-30), cuts: 1 });
    expect(cuts.detect(T + 62_000)).toMatchObject([{ kind: "visual", reasons: ["Rapid scene changes (3 in 4 s)"], intensity: 60 }]);
  });

  it("needs 30 s of history first, ignores a single loud second, and forgets on reset", () => {
    const s = new LiveSignals();
    steady(s, 10, T);
    steady(s, 3, T + 10_000, -10);
    expect(s.detect(T + 12_000)).toEqual([]);
    const t = new LiveSignals();
    steady(t, 60, T);
    t.add({ t: T + 60_000, db: -10, motion: 3, brightness: 100 });
    steady(t, 2, T + 61_000);
    expect(t.detect(T + 62_000).filter((x) => x.reasons.some((r) => r.includes("louder")))).toEqual([]);
    t.reset();
    expect(t.length).toBe(0);
  });

  it("rhythm score: high for 4–6 Hz pulses, low for steady sound and slow changes", () => {
    expect(rhythmScore(Array.from({ length: 40 }, (_, i) => (i % 4 < 2 ? -10 : -30)))).toBeGreaterThan(0.6);
    expect(rhythmScore(Array.from({ length: 40 }, () => -20))).toBe(0);
    expect(rhythmScore(Array.from({ length: 40 }, (_, i) => (i < 20 ? -10 : -30)))).toBeLessThan(0.5);
  });

  it("measures loudness, zero crossings and 50 ms slices from raw samples", () => {
    const m = new AudioFeatureMeter(1000);
    expect(m.take()).toBeNull();
    const tone = Float32Array.from({ length: 1000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 10 * i) / 1000)); // 10 Hz, 1 s
    m.add(tone);
    const f = m.take()!;
    expect(f.db).toBeCloseTo(-9, 0);
    expect(f.zcr).toBeCloseTo(0.02, 2);
    expect(f.envelope).toHaveLength(20);
  });
});
