/**
 * MP4/MOV demuxing with mp4box.js for WebCodecs. Only the file index (moov) is parsed up front;
 * sample data is read from the Blob in byte ranges when needed, so a large authorized file never
 * has to fit in memory. WebM isn't supported here (the browser can still play it for analysis).
 */
import { createFile, DataStream, Endianness, MP4BoxBuffer, type ISOFile, type Sample } from "mp4box";

export interface TrackSamples {
  id: number;
  codec: string;
  timescale: number;
  samples: Sample[];
}

export interface Demuxed {
  durationSec: number;
  video: TrackSamples & { width: number; height: number; description: Uint8Array | undefined };
  audio: (TrackSamples & { sampleRate: number; channels: number; description: Uint8Array | undefined }) | null;
  read: (samples: Sample[]) => Promise<Uint8Array[]>;
}

export class MediaError extends Error {}

const CHUNK = 4 * 1024 * 1024;

export async function demux(blob: Blob): Promise<Demuxed> {
  const file: ISOFile = createFile(false);
  let ready = false;
  let failed: string | null = null;
  file.onReady = () => {
    ready = true;
  };
  file.onError = (_m: string, msg: string) => {
    failed = msg;
  };
  let pos = 0;
  let fragmented = false;
  while (pos < blob.size && !failed) {
    const ab = await blob.slice(pos, pos + CHUNK).arrayBuffer();
    const buf = MP4BoxBuffer.fromArrayBuffer(ab, pos);
    const next = file.appendBuffer(buf, pos + ab.byteLength >= blob.size);
    if (ready) {
      fragmented = file.getInfo().isFragmented;
      if (!fragmented) break;
    }
    // mp4box tells us where the next box it needs starts (skips mdat when moov comes later).
    pos = typeof next === "number" && next > pos ? next : pos + ab.byteLength;
  }
  file.flush();
  if (failed) throw new MediaError(`This file can't be read as MP4 (${failed}).`);
  if (!ready) throw new MediaError("This file isn't a playable MP4/MOV file (no index found).");
  const info = file.getInfo();
  const v = info.videoTracks[0];
  if (!v?.video) throw new MediaError("This file has no video track.");
  const a = info.audioTracks[0] ?? null;
  const vSamples = file.getTrackSamplesInfo(v.id);
  if (!vSamples.length) throw new MediaError("This file's video track is empty.");
  const aSamples = a ? file.getTrackSamplesInfo(a.id) : [];
  const durationSec = info.duration && info.timescale ? info.duration / info.timescale : vSamples.reduce((s, x) => s + x.duration, 0) / v.timescale;

  return {
    durationSec,
    video: { id: v.id, codec: v.codec, timescale: v.timescale, samples: vSamples, width: v.video.width, height: v.video.height, description: codecDescription(file, v.id) },
    audio: a && aSamples.length
      ? { id: a.id, codec: a.codec, timescale: a.timescale, samples: aSamples, sampleRate: a.audio?.sample_rate ?? 48000, channels: a.audio?.channel_count ?? 2, description: codecDescription(file, a.id) }
      : null,
    read: (samples) => readSamples(blob, samples),
  };
}

/** Sample bytes, read in contiguous ranges (up to 8 MB per read). */
async function readSamples(blob: Blob, samples: Sample[]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = new Array(samples.length);
  let i = 0;
  while (i < samples.length) {
    const start = samples[i]!.offset;
    let end = start + samples[i]!.size;
    let j = i + 1;
    while (j < samples.length && samples[j]!.offset === end && end - start < 8 * 1024 * 1024) end += samples[j++]!.size;
    const buf = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    for (let k = i; k < j; k++) out[k] = buf.subarray(samples[k]!.offset - start, samples[k]!.offset - start + samples[k]!.size);
    i = j;
  }
  return out;
}

/** The decoder configuration record (avcC/hvcC/vpcC/av1C) or AAC AudioSpecificConfig. */
function codecDescription(file: ISOFile, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId) as unknown as { mdia: { minf: { stbl: { stsd: { entries: Record<string, unknown>[] } } } } };
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = (entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C) as { write: (s: DataStream) => void } | undefined;
    if (box) {
      const s = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(s);
      return new Uint8Array(s.buffer as ArrayBuffer, 8); // skip the box header
    }
    const esds = entry.esds as { esd?: { descs?: { descs?: { data?: Uint8Array }[] }[] } } | undefined;
    const dsi = esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    if (dsi) return new Uint8Array(dsi);
  }
  return undefined;
}

/** Microseconds of a sample's presentation time. */
export const ptsUs = (s: Sample) => Math.round((s.cts * 1_000_000) / s.timescale);
export const durUs = (s: Sample) => Math.round((s.duration * 1_000_000) / s.timescale);
