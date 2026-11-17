import { Downsampler, PCM_RATE, PcmBatcher, toBase64 } from "./pcm";

function fromBase64(b64: string): Int16Array {
  const bin = atob(b64);
  const out = new Int16Array(bin.length / 2);
  const view = new DataView(Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

describe("16 kHz audio for live sound detection", () => {
  it("downsamples 48 kHz by averaging, across block boundaries", () => {
    const d = new Downsampler(48_000);
    const a = d.push([0.3, 0.3, 0.3, 0.6, 0.6]); // the second output needs one more input sample
    const b = d.push([0.6, -1, -1, -1]);
    expect(Array.from(a)).toEqual([Math.round(0.3 * 32767)]);
    expect(Array.from(b)).toEqual([Math.round(0.6 * 32767), -32767]);
  });

  it("keeps 44.1 kHz at 16 000 samples per second", () => {
    const d = new Downsampler(44_100);
    let n = 0;
    for (let i = 0; i < 10; i++) n += d.push(new Float32Array(4410)).length;
    expect(Math.abs(n - PCM_RATE)).toBeLessThanOrEqual(1);
  });

  it("encodes little-endian 16-bit base64", () => {
    expect(toBase64(Int16Array.from([1, -2]))).toBe("AQD+/w==");
    expect(Array.from(fromBase64(toBase64(Int16Array.from([32767, -32768, 0]))))).toEqual([32767, -32768, 0]);
  });

  it("hands out batches that overlap by one second", () => {
    const b = new PcmBatcher();
    expect(b.take()).toBeNull();
    const t0 = Date.parse("2026-11-16T12:00:05Z");
    b.add(new Int16Array(5 * PCM_RATE).fill(1), t0); // 0–5 s
    const first = b.take()!;
    expect(first.start).toBe("2026-11-16T12:00:00.000Z");
    expect(fromBase64(first.data).length).toBe(5 * PCM_RATE);
    expect(b.take()).toBeNull();

    b.add(new Int16Array(5 * PCM_RATE).fill(2), t0 + 5000); // 5–10 s
    const second = b.take()!;
    const s = fromBase64(second.data);
    expect(second.start).toBe("2026-11-16T12:00:04.000Z");
    expect(s.length).toBe(6 * PCM_RATE);
    expect([s[0], s[PCM_RATE - 1], s[PCM_RATE]]).toEqual([1, 1, 2]);
  });

  it("drops the oldest audio instead of growing while nothing is sent", () => {
    const b = new PcmBatcher();
    for (let i = 0; i < 30; i++) b.add(new Int16Array(PCM_RATE), Date.parse("2026-11-16T12:00:00Z") + i * 1000);
    expect(fromBase64(b.take()!.data).length).toBe(11 * PCM_RATE);
  });
});
