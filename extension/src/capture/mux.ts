import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { Chunk } from "./buffer";

export interface TrackConfigs {
  video: { width: number; height: number; decoderConfig: VideoDecoderConfig };
  audio: { codec: "aac" | "opus"; sampleRate: number; numberOfChannels: number; decoderConfig: AudioDecoderConfig } | null;
}

/** Encoded chunks → an MP4 file (no re-encoding). Tracks start at 0 and stay in sync. */
export function muxMp4(video: Chunk[], audio: Chunk[], cfg: TrackConfigs): Blob {
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: cfg.video.width, height: cfg.video.height },
    audio: cfg.audio && audio.length ? { codec: cfg.audio.codec, sampleRate: cfg.audio.sampleRate, numberOfChannels: cfg.audio.numberOfChannels } : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "cross-track-offset",
  });
  const t0 = Math.min(video[0]?.at ?? Infinity, audio[0]?.at ?? Infinity);
  const us = (ms: number) => Math.max(0, Math.round((ms - t0) * 1000));
  video.forEach((c, i) =>
    muxer.addVideoChunkRaw(c.data, c.key ? "key" : "delta", us(c.at), Math.round(c.duration * 1000), i === 0 ? { decoderConfig: cfg.video.decoderConfig } : undefined),
  );
  if (cfg.audio)
    audio.forEach((c, i) =>
      muxer.addAudioChunkRaw(c.data, "key", us(c.at), Math.round(c.duration * 1000), i === 0 ? { decoderConfig: cfg.audio!.decoderConfig } : undefined),
    );
  muxer.finalize();
  return new Blob([new Uint8Array(target.buffer)], { type: "video/mp4" });
}
