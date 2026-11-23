import { ActionTracker, columnEnergy, cropFor } from "./layout";

/** A 64×36 grey frame with a white box (anti-aliased at fractional edges), as the 64×36 probe sees it. */
function frame(boxLeft: number, boxWidth: number, noise = 0, seed = { s: 1 }): Uint8ClampedArray {
  const g = new Uint8ClampedArray(64 * 36);
  for (let x = 0; x < 64; x++) {
    const cover = Math.max(0, Math.min(x + 1, boxLeft + boxWidth) - Math.max(x, boxLeft));
    for (let y = 0; y < 36; y++) {
      seed.s = (seed.s * 16807) % 2147483647;
      const n = noise ? ((seed.s / 2147483647) - 0.5) * noise : 0;
      g[y * 64 + x] = (y >= 12 && y < 24 ? cover * 255 : 0) + n;
    }
  }
  return g;
}

/** Runs the tracker over a box path (left edge in columns per frame); returns per-frame [x, boxCentre]. */
function run(path: (f: number) => number, frames: number, opts: { width?: number; noise?: number; tracker?: ActionTracker; repeat?: number } = {}) {
  const t = opts.tracker ?? new ActionTracker();
  const w = opts.width ?? 6.7;
  const seed = { s: 7 };
  let prev = frame(path(0), w, opts.noise, seed);
  const out: [number, number][] = [];
  const rep = opts.repeat ?? 1;
  for (let f = 1; f < frames; f++) {
    // A source with repeated frames (e.g. 10 fps motion in a 30 fps file) only changes every `rep` frames.
    const cur = frame(path(f - (f % rep)), w, opts.noise, seed);
    t.update(columnEnergy(prev, cur, 64, 36));
    prev = cur;
    out.push([t.position, (path(f - (f % rep)) + w / 2) / 64]);
  }
  return out;
}

/** Is the box fully inside a 9:16 crop of a 1920×1080 frame centred on x? */
const inside = (x: number, centre: number, boxW = 200) => {
  const c = cropFor(1920, 1080, 1080 / 1920, x);
  return centre * 1920 - boxW / 2 >= c.sx && centre * 1920 + boxW / 2 <= c.sx + c.sw;
};

describe("follow the action", () => {
  it("keeps a box moving at a steady speed (80 px/s at 30 fps) inside the crop, close to the centre", () => {
    const speed = (80 / 1920) * 64 / 30; // columns per frame
    const r = run((f) => 6 + f * speed, 560); // the box reaches the right edge of the picture at about frame 580
    const settled = r.slice(90);
    const lag = Math.max(...settled.map(([x, c]) => Math.abs(c - x)));
    expect(settled.every(([x, c]) => inside(x, c))).toBe(true);
    expect(lag).toBeLessThan(0.015);
  });

  it("follows just as closely when the picture only changes every third frame (repeated frames)", () => {
    const speed = (80 / 1920) * 64 / 30;
    const r = run((f) => 6 + f * speed, 560, { repeat: 3 });
    const settled = r.slice(90);
    expect(settled.every(([x, c]) => inside(x, c))).toBe(true);
    expect(Math.max(...settled.map(([x, c]) => Math.abs(c - x)))).toBeLessThan(0.015);
  });

  it("keeps a faster box (300 px/s) in the crop", () => {
    const speed = (300 / 1920) * 64 / 30;
    const r = run((f) => 4 + f * speed, 160);
    expect(r.slice(45).every(([x, c]) => inside(x, c))).toBe(true);
  });

  it("stays still on a still box with sensor noise (no drifting or jitter)", () => {
    const r = run(() => 30, 300, { noise: 30 });
    const xs = r.slice(10).map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.01);
  });

  it("doesn't twitch when the subject only bobs a little (a face moving ±30 px)", () => {
    const amp = (30 / 1920) * 64;
    const r = run((f) => 30 + amp * Math.sin(f / 6), 600);
    const xs = r.slice(30).map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.03);
  });

  it("glides after the box stops instead of overshooting far past it", () => {
    const speed = (150 / 1920) * 64 / 30;
    const stopAt = 200;
    const r = run((f) => 6 + Math.min(f, stopAt) * speed, 400);
    const centre = (6 + stopAt * speed + 3.35) / 64;
    const after = r.slice(stopAt).map(([x]) => x);
    expect(Math.max(...after) - centre).toBeLessThan(0.05);
    expect(Math.abs(after.at(-1)! - centre)).toBeLessThan(0.03);
  });

  it("moves back and forth with a box that changes direction", () => {
    const speed = (120 / 1920) * 64 / 30;
    const r = run((f) => 30 + 20 * Math.sin((f * speed) / 20), 900);
    expect(r.slice(60).filter(([x, c]) => !inside(x, c)).length).toBe(0);
  });
});
