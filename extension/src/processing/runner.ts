/**
 * The processing queue, run in the offscreen document (WebCodecs needs a document). Work is stored
 * in IndexedDB, so nothing is lost when the document closes: analyses of authorized files, clips
 * cut from them, then output assets. One item at a time; the worker is told what finished.
 */
import { db } from "@/local/db";
import { saveClip, type LocalClip } from "@/local/clips";
import { listSources, sourceBlob, updateSource, type SourceFile } from "@/local/sources";
import { check } from "@/local/rights";
import { nextQueuedAsset, patchAsset, type Asset } from "@/local/assets";
import type { Platform } from "@/types/api";
import { analyzeFile } from "./analyze";
import { demux } from "./demux";
import { X_LIMITS, xProblems } from "./layout";
import { transcode } from "./transcode";

export type RunnerEvent = { type: "process/clip-made"; clipId: number; sourceId: number } | { type: "process/asset-done"; assetId: number; clipId: number; ok: boolean } | { type: "process/idle" };

let running = false;
export const isBusy = () => running;

const message = (e: unknown) => (e instanceof Error ? e.message : "Processing failed");

export async function runQueue(emit: (e: RunnerEvent) => Promise<unknown> | void): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (await nextAnalysis()) continue;
      const made = await nextSourceClip();
      if (made) {
        // Wait until the worker has queued the new clip's formats, so the loop finds them.
        await emit({ type: "process/clip-made", ...made });
        continue;
      }
      const a = await nextQueuedAsset();
      if (!a) break;
      const ok = await makeAsset(a);
      void emit({ type: "process/asset-done", assetId: a.id, clipId: a.clip_id, ok });
    }
  } finally {
    running = false;
    void emit({ type: "process/idle" });
  }
}

async function nextAnalysis(): Promise<boolean> {
  const s = (await listSources()).find((x) => x.analysis === "queued" || x.analysis === "analyzing");
  if (!s) return false;
  // "analyzing" here was left by a closed document: try once more, then give up.
  if (s.analysis === "analyzing" && s.analysis_error === "retry") {
    await updateSource(s.id, { analysis: "failed", analysis_error: "Analysis was interrupted twice." });
    return true;
  }
  await updateSource(s.id, { analysis: "analyzing", analysis_error: s.analysis === "analyzing" ? "retry" : null });
  try {
    if (!check(s.rights, "analyze").ok) throw new Error("This file isn't authorized for analysis.");
    const blob = await sourceBlob(s.id);
    if (!blob) throw new Error("The file is no longer stored.");
    const r = await analyzeFile(blob);
    await updateSource(s.id, { analysis: "analyzed", analysis_error: null, moments: r.moments, duration_seconds: r.durationSec, width: r.width, height: r.height });
  } catch (e) {
    await updateSource(s.id, { analysis: "failed", analysis_error: message(e) });
  }
  return true;
}

async function nextSourceClip(): Promise<{ clipId: number; sourceId: number } | null> {
  const s = (await listSources()).find((x) => (x.pending_clips ?? []).length > 0);
  if (!s) return null;
  const [req, ...rest] = s.pending_clips!;
  await updateSource(s.id, { pending_clips: rest });
  try {
    if (!check(s.rights, "process").ok) throw new Error("This file isn't authorized for processing.");
    const blob = await sourceBlob(s.id);
    if (!blob) throw new Error("The file is no longer stored.");
    const r = await transcode(blob, { kind: "landscape", startSec: req!.start, endSec: req!.end });
    const clip = await saveClip({
      candidateId: 0,
      sessionId: null,
      streamerId: 0,
      streamerName: s.creator_name,
      platform: s.platform as Platform,
      title: req!.title || `${s.creator_name} – ${fmt(req!.start)}`,
      startedAt: Date.now(),
      durationSec: r.durationSec,
      width: r.width,
      height: r.height,
      score: req!.score ?? 0,
      blob: r.blob,
      reasons: req!.reasons ?? ["Cut by you from an authorized file"],
      detectionTypes: ["manual"],
      thumbnail: r.thumbnail,
    });
    await db.put<LocalClip & { source_id: number; original_url: string | null; source_offset_sec: number }>("clips", { ...clip, source_id: s.id, original_url: s.original_url, source_offset_sec: req!.start });
    await updateSource(s.id, { clip_ids: [...(s.clip_ids ?? []), clip.id], clip_error: null });
    if (req!.segment_id !== undefined) await patchSegment(req!.segment_id, { status: "extracted", clip_id: clip.id, error: null });
    return { clipId: clip.id, sourceId: s.id };
  } catch (e) {
    await updateSource(s.id, { clip_error: message(e) });
    if (req!.segment_id !== undefined) await patchSegment(req!.segment_id, { status: "failed", error: message(e) });
    return null;
  }
}

async function patchSegment(id: number, patch: Record<string, unknown>): Promise<void> {
  const seg = await db.get<Record<string, unknown>>("segments", id);
  if (seg) await db.put("segments", { ...seg, ...patch, id });
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

async function makeAsset(a: Asset): Promise<boolean> {
  await patchAsset(a.id, { status: "processing", progress: 0, error: null });
  let lastReported = 0;
  const onProgress = (f: number) => {
    if (f - lastReported >= 0.1) {
      lastReported = f;
      void patchAsset(a.id, { progress: Math.round(f * 100) / 100 });
    }
  };
  try {
    const clip = await db.get<LocalClip>("clips", a.clip_id);
    const blob = await db.get<Blob>("clipBlobs", a.clip_id);
    if (!clip || !blob) throw new Error("The clip was deleted.");
    const src = await demux(blob);
    if (a.kind === "landscape") {
      const info = { durationSec: src.durationSec, width: src.video.width, height: src.video.height, videoCodec: src.video.codec, audioCodec: src.audio?.codec ?? null, sizeBytes: blob.size };
      const problems = xProblems(info);
      if (!problems.length) {
        await patchAsset(a.id, {
          status: "ready", progress: 1, reused_original: true, used_layout: "landscape", width: info.width, height: info.height,
          duration_seconds: Math.round(info.durationSec * 10) / 10, size_bytes: blob.size, notes: ["The original clip already meets X's limits, so it's used as it is (no copy)."],
        });
        return true;
      }
      const r = await transcode(src, { kind: "landscape", endSec: Math.min(src.durationSec, X_LIMITS.maxSeconds), onProgress });
      await store(a, r.blob, r.thumbnail);
      await patchAsset(a.id, {
        status: "ready", progress: 1, used_layout: "landscape", width: r.width, height: r.height, duration_seconds: r.durationSec, size_bytes: r.blob.size,
        has_thumbnail: Boolean(r.thumbnail), notes: [`Re-encoded for X (${problems.join(", ")}).`, ...(src.durationSec > X_LIMITS.maxSeconds ? [`Shortened to X's ${X_LIMITS.maxSeconds} s limit.`] : []), ...r.notes],
      });
      return true;
    }
    const r = await transcode(src, { kind: "vertical", layout: a.layout, onProgress });
    await store(a, r.blob, r.thumbnail);
    await patchAsset(a.id, { status: "ready", progress: 1, used_layout: r.used, width: r.width, height: r.height, duration_seconds: r.durationSec, size_bytes: r.blob.size, has_thumbnail: Boolean(r.thumbnail), notes: r.notes, action_path: r.actionPath.length ? r.actionPath : null });
    return true;
  } catch (e) {
    await patchAsset(a.id, { status: "failed", error: message(e), attempts: a.attempts + 1 });
    return false;
  }
}

async function store(a: Asset, blob: Blob, thumb: Blob | null) {
  await db.putBlob(a.id, blob, "assetBlobs");
  if (thumb) await db.putBlob(-a.id, thumb, "assetBlobs");
}

export type { SourceFile };
