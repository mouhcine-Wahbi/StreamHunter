/**
 * "Clean gaming (motion)": the vertical base video StreamHunter already made (layout crop, trim,
 * loudness), plus one controlled punch-in zoom on the gameplay at the measured strongest moment,
 * a short fade-in at the opening, and (only if you enable them) captions from the transcript.
 * Nothing else is added: no invented text, events or speech.
 */
import { AbsoluteFill, Easing, interpolate, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";

export interface Caption {
  /** Seconds in this Short. */
  start: number;
  end: number;
  text: string;
}
export interface CleanGamingProps {
  /** File name in the bundle's public folder. */
  src: string;
  durationInFrames: number;
  fps: number;
  /** Height of the facecam panel at the top (0 = no facecam panel); only the gameplay below it is zoomed. */
  splitY: number;
  /** One punch-in: frames [in, peak-hold-start, hold-end, out], scale ≤ 1.15. */
  zoom: { frames: [number, number, number, number]; scale: number } | null;
  fadeInFrames: number;
  captions: Caption[];
}

const MAX_ZOOM = 1.15;

export function zoomAt(frame: number, zoom: CleanGamingProps["zoom"]): number {
  if (!zoom) return 1;
  const s = Math.min(MAX_ZOOM, Math.max(1, zoom.scale));
  const [a, b, c, d] = zoom.frames;
  return interpolate(frame, [a, b, c, d], [1, s, s, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
}

export function CleanGaming(p: CleanGamingProps) {
  const frame = useCurrentFrame();
  const scale = zoomAt(frame, p.zoom);
  const src = staticFile(p.src);
  const opacity = p.fadeInFrames > 0 ? interpolate(frame, [0, p.fadeInFrames], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const gameH = 1920 - p.splitY;
  const t = frame / p.fps;
  const caption = p.captions.find((c) => t >= c.start && t < c.end);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ opacity }}>
        {/* Gameplay (the whole frame when there is no facecam panel), zoomed around its centre. */}
        <div style={{ position: "absolute", left: 0, top: p.splitY, width: 1080, height: gameH, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: -p.splitY, width: 1080, height: 1920, transform: `scale(${scale})`, transformOrigin: `540px ${p.splitY + gameH / 2}px` }}>
            <OffthreadVideo src={src} style={{ width: 1080, height: 1920 }} />
          </div>
        </div>
        {/* Facecam panel, never zoomed. */}
        {p.splitY > 0 && (
          <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: p.splitY, overflow: "hidden" }}>
            <OffthreadVideo src={src} muted style={{ width: 1080, height: 1920 }} />
          </div>
        )}
      </AbsoluteFill>
      {caption && (
        <div style={{ position: "absolute", left: 60, right: 60, bottom: 260, textAlign: "center" }}>
          <span
            style={{
              fontFamily: "-apple-system, 'Helvetica Neue', Arial, sans-serif",
              fontWeight: 800,
              fontSize: 64,
              lineHeight: 1.2,
              color: "white",
              WebkitTextStroke: "3px black",
              paintOrder: "stroke",
              textShadow: "0 4px 12px rgba(0,0,0,0.6)",
            }}
          >
            {caption.text}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
}
