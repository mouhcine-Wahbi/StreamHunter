/**
 * Edit plans → FFmpeg commands (pure, unit-tested). The extension sends a plan built from what
 * StreamHunter measured (layout geometry, the action path, the strongest moment); the companion
 * checks it against the real input and turns it into FFmpeg arguments. Nothing is invented: the
 * plan only crops, scales, stacks, trims and normalizes the original picture and sound.
 */
export const TEMPLATE_FFMPEG = "ffmpeg_clean_v1";
export const TEMPLATE_REMOTION = "remotion_clean_gaming_v1";
export const MAX_ZOOM = 1.15;
export const MAX_CAPTIONS = 400;
export const MAX_PATH_POINTS = 48;

const num = (v) => typeof v === "number" && Number.isFinite(v);

/** Validates a plan against the probed input; returns a list of problems (empty = OK). */
export function checkPlan(plan, input) {
  const p = [];
  if (!plan || plan.version !== 1) return ["Unsupported plan version"];
  const { output: o, panels, trim } = plan;
  if (!o || o.width !== 1080 || o.height !== 1920) p.push("Output must be 1080×1920");
  if (!Array.isArray(panels) || panels.length < 1 || panels.length > 2) p.push("One or two panels expected");
  else {
    let y = 0;
    for (const [i, s] of panels.entries()) {
      if (![s.sx, s.sy, s.sw, s.sh, s.dy, s.dh].every(num)) {
        p.push(`Panel ${i + 1}: missing numbers`);
        continue;
      }
      if (s.dy !== y) p.push(`Panel ${i + 1}: panels must be stacked from the top`);
      y += s.dh;
      if (s.sw < 16 || s.sh < 16 || s.dh < 16 || s.dh % 2) p.push(`Panel ${i + 1}: size out of range`);
      if (s.sx < 0 || s.sy < 0 || s.sx + s.sw > input.width + 1 || s.sy + s.sh > input.height + 1) p.push(`Panel ${i + 1}: crop outside the picture`);
      if (s.sxPath && (!Array.isArray(s.sxPath) || s.sxPath.length > MAX_PATH_POINTS || !s.sxPath.every((k) => Array.isArray(k) && num(k[0]) && num(k[1])))) p.push(`Panel ${i + 1}: invalid action path`);
    }
    if (y !== 1920) p.push("Panels must fill the 1920 px height");
  }
  if (!trim || !num(trim.start) || trim.start < 0 || (trim.end !== null && (!num(trim.end) || trim.end <= trim.start))) p.push("Invalid trim");
  else if (trim.start >= input.duration) p.push("Trim starts after the end of the clip");
  if (!["videotoolbox", "x264"].includes(plan.encoder)) p.push("Unknown encoder");
  const m = plan.motion;
  if (m !== undefined && m !== null) {
    if (typeof m !== "object") p.push("Invalid motion");
    else {
      if (m.zoomAt !== null && (!num(m.zoomAt) || m.zoomAt < 0)) p.push("Invalid zoom time");
      if (!num(m.zoomScale) || m.zoomScale < 1 || m.zoomScale > MAX_ZOOM) p.push(`Zoom must be between 1 and ${MAX_ZOOM}`);
      if (!num(m.fadeIn) || m.fadeIn < 0 || m.fadeIn > 1) p.push("Invalid opening fade");
    }
  }
  const c = plan.captions;
  if (c !== undefined && c !== null) {
    if (!Array.isArray(c) || c.length > MAX_CAPTIONS || !c.every((x) => x && num(x.start) && num(x.end) && x.end > x.start && typeof x.text === "string" && x.text.length <= 200)) p.push("Invalid captions");
    else if (c.length && !m) p.push("Captions need the Remotion template");
  }
  return p;
}

const r2 = (v) => Math.round(v * 100) / 100;

/** Piecewise-linear crop x over time, clamped to the picture: FFmpeg expression syntax. */
export function pathExpr(points, maxX) {
  const pts = [...points].sort((a, b) => a[0] - b[0]).map(([t, x]) => [r2(t), Math.round(x)]);
  if (!pts.length) return "0";
  let expr = String(pts[pts.length - 1][1]);
  for (let i = pts.length - 2; i >= 0; i--) {
    const [t0, x0] = pts[i];
    const [t1, x1] = pts[i + 1];
    const seg = t1 > t0 && x1 !== x0 ? `${x0}+${x1 - x0}*(t-${t0})/${r2(t1 - t0)}` : String(x0);
    expr = `if(lt(t,${t1}),${seg},${expr})`;
  }
  expr = `if(lt(t,${pts[0][0]}),${pts[0][1]},${expr})`;
  return `clip(${expr},0,${Math.max(0, maxX)})`;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function filterGraph(plan, input) {
  const fps = Math.min(plan.output.maxFps ?? 60, input.fps || 30);
  const crops = plan.panels.map((s) => {
    const w = even(Math.min(s.sw, input.width));
    const h = even(Math.min(s.sh, input.height));
    // Path times are seconds from the clip start; after -ss the filter clock starts at the trim.
    const x = s.sxPath?.length ? `'${pathExpr(s.sxPath.map(([t, px]) => [t - plan.trim.start, px]), input.width - w)}'` : String(Math.round(Math.min(Math.max(0, s.sx), input.width - w)));
    const y = Math.round(Math.min(Math.max(0, s.sy), input.height - h));
    return `crop=w=${w}:h=${h}:x=${x}:y=${y},scale=1080:${s.dh}:flags=lanczos,setsar=1`;
  });
  const tail = `fps=${fps},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`;
  if (crops.length === 1) return `[0:v]${crops[0]},${tail}[v]`;
  return `[0:v]split=2[a][b];[a]${crops[0]}[top];[b]${crops[1]}[bot];[top][bot]vstack=inputs=2,${tail}[v]`;
}

export function ffmpegArgs(plan, input, out) {
  const args = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"];
  if (plan.trim.start > 0) args.push("-ss", String(plan.trim.start));
  if (plan.trim.end !== null) args.push("-to", String(plan.trim.end));
  args.push("-i", input.path, "-filter_complex", filterGraph(plan, input), "-map", "[v]");
  if (input.hasAudio) {
    args.push("-map", "0:a:0");
    if (plan.audio?.loudnorm) args.push("-af", "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000");
    else args.push("-ar", "48000");
    args.push("-c:a", "aac", "-b:a", "160k", "-ac", "2");
  } else args.push("-an");
  if (plan.encoder === "videotoolbox") args.push("-c:v", "h264_videotoolbox", "-b:v", "10M", "-maxrate", "14M", "-bufsize", "20M", "-profile:v", "high", "-allow_sw", "1");
  else args.push("-c:v", "libx264", "-preset", "medium", "-crf", "19", "-profile:v", "high");
  // Tag the colours (BT.709) so browsers and players decode them the same way.
  args.push("-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv");
  args.push("-g", String(Math.round(Math.min(plan.output.maxFps ?? 60, input.fps || 30) * 2)), "-movflags", "+faststart", "-f", "mp4", out);
  return args;
}

/** Expected output length after the trim. */
export function expectedDuration(plan, input) {
  const end = plan.trim.end === null ? input.duration : Math.min(plan.trim.end, input.duration);
  return Math.max(0, end - plan.trim.start);
}

/** What ffprobe says about a file, reduced to what the editor needs. */
export function readProbe(json) {
  const streams = json?.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  if (!v) return null;
  const [n, d] = String(v.avg_frame_rate ?? v.r_frame_rate ?? "30/1").split("/").map(Number);
  const duration = Number(json.format?.duration ?? v.duration);
  return {
    width: Number(v.width),
    height: Number(v.height),
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name ?? null,
    hasAudio: Boolean(a),
    fps: d ? Math.round((n / d) * 100) / 100 : 30,
    duration: Number.isFinite(duration) ? duration : 0,
  };
}

/** Checks an encoded output; returns problems (empty = OK). */
export function checkOutput(probe, plan, input) {
  const p = [];
  if (!probe) return ["The output has no video stream"];
  if (probe.width !== 1080 || probe.height !== 1920) p.push(`Output is ${probe.width}×${probe.height}, not 1080×1920`);
  if (probe.videoCodec !== "h264") p.push(`Output video is ${probe.videoCodec}, not H.264`);
  if (input.hasAudio && probe.audioCodec !== "aac") p.push("Output audio is missing or not AAC");
  const want = expectedDuration(plan, input);
  if (Math.abs(probe.duration - want) > 0.6) p.push(`Output lasts ${probe.duration.toFixed(1)} s, expected ${want.toFixed(1)} s`);
  return p;
}

/**
 * Props for the Remotion template from the plan and the probed base video: one punch-in around
 * the strongest moment (0.4 s in, 1.2 s hold, 0.4 s out, clamped to the Short), the opening fade,
 * and captions (already in the Short's time).
 */
export function motionProps(plan, base) {
  const fps = base.fps || 30;
  const total = Math.max(1, Math.round(base.duration * fps));
  const m = plan.motion;
  let zoom = null;
  if (m.zoomAt !== null && m.zoomScale > 1) {
    const at = Math.round(m.zoomAt * fps);
    const f = [at - Math.round(0.4 * fps), at, at + Math.round(1.2 * fps), at + Math.round(1.6 * fps)].map((x) => Math.min(total - 1, Math.max(0, x)));
    if (f[3] > f[0] && f[1] > f[0]) zoom = { frames: f, scale: Math.min(MAX_ZOOM, m.zoomScale) };
  }
  return {
    durationInFrames: total,
    fps,
    splitY: plan.panels.length === 2 ? plan.panels[0].dh : 0,
    zoom,
    fadeInFrames: Math.round((m.fadeIn ?? 0) * fps),
    captions: (plan.captions ?? []).map((c) => ({ start: c.start, end: c.end, text: c.text })),
  };
}
