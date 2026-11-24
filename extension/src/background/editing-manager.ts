/**
 * 4.0 automatic editing (worker side). A clip whose viral-potential score reaches the "edit
 * automatically" threshold is sent to the companion, which makes a vertical 1080×1920 Short with
 * FFmpeg; the Short is saved as a separate "Edited Short" version. The original clip is never
 * changed. Scores in the "offer" band get an Edit button instead; lower scores are not edited.
 */
import { db } from "@/local/db";
import { listAssets, type Asset } from "@/local/assets";
import type { ContentClip } from "@/local/content";
import { createEditJob, EDIT_STATE_LABEL, EDIT_TERMINAL, editJobByKey, getEditJob, listEditJobs, patchEditJob, type EditJob, type EditState } from "@/local/edits";
import { buildEditPlan, captionsFor, decideEdit, dedupeKey } from "@/editing/rules";
import { getTranscript, putTranscript, type Transcript } from "@/local/transcripts";
import { sourceBlob, updateSource, type SourceFile } from "@/local/sources";
import { saveSegments, type Segment } from "@/clipper/clipper";
import { getFile, putFile, type CompanionEndpoint, type CompanionEvent, type CompanionJob } from "@/companion/client";
import type { Settings } from "@/types/settings";

export class EditError extends Error {}

export interface EditingDeps {
  companion: {
    endpoint: () => Promise<CompanionEndpoint>;
    request: <T>(type: string, payload?: Record<string, unknown>) => Promise<T>;
    onEvent: (l: (e: CompanionEvent) => void) => () => void;
    hold: (on: boolean) => void;
  };
  /** True while a stream is being recorded (for "pause while recording"). */
  isRecording: () => Promise<boolean>;
  fetch?: typeof fetch;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Backup polling while edits run (events are the main signal). */
  pollMs?: number;
}

const inputName = (j: EditJob) => `${j.companion_id}-in.mp4`;
const trId = (clipId: number) => `sh-tr-${clipId}`;
const CAPTION_NOTE = /^(Captions: |No speech was found, so)/;
interface TranscribeOutput {
  transcript: string;
  language: string | null;
  segments: number;
  dropped: number;
  duration: number;
}

export function createEditingManager(deps: EditingDeps) {
  const log = deps.log ?? (() => undefined);
  const fetchImpl = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const held = new Set<number>();
  const importing = new Set<number>();
  let poll: ReturnType<typeof setInterval> | null = null;

  const hold = (id: number, on: boolean) => {
    if (on && !held.has(id)) {
      held.add(id);
      deps.companion.hold(true);
    } else if (!on && held.delete(id)) deps.companion.hold(false);
    if (held.size && !poll) poll = setInterval(() => void pollActive(), deps.pollMs ?? 5000);
    if (!held.size && poll) {
      clearInterval(poll);
      poll = null;
    }
  };

  const transcribing = new Map<number, Promise<Transcript>>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * 4.4: a transcript of the clip, made by the companion with Whisper (once per clip; kept in the
   * database). `onProgress` gets the companion's progress while it runs.
   */
  type WhisperData = Omit<Transcript, "clip_id" | "metrics" | "created_at">;
  /** Runs Whisper in the companion on a file and returns its (guarded) transcript. */
  async function runWhisper(id: string, blob: Blob, holdKey: number, onProgress?: (cj: CompanionJob) => void): Promise<{ data: WhisperData; metrics: CompanionJob["metrics"] }> {
    hold(holdKey, true);
    try {
      const ep = await deps.companion.endpoint();
      let cj = await deps.companion.request<CompanionJob | null>("jobs/get", { id_job: id }).catch(() => null);
      if (!cj || cj.state === "failed" || cj.state === "cancelled") {
        await putFile(ep, `${id}-in.mp4`, blob, fetchImpl);
        cj = await deps.companion.request<CompanionJob>("transcribe/start", { id_job: id, input: `${id}-in.mp4` }).catch((e: unknown) => {
          const m = e instanceof Error ? e.message : String(e);
          throw new EditError(/Unknown request/i.test(m) ? "This companion can't transcribe yet. Update it (run the installer from the new StreamHunter folder)." : m);
        });
      }
      while (cj && cj.state !== "done" && cj.state !== "failed" && cj.state !== "cancelled") {
        onProgress?.(cj);
        await sleep(deps.pollMs ? Math.min(deps.pollMs, 1000) : 1000);
        cj = await deps.companion.request<CompanionJob | null>("jobs/get", { id_job: id });
      }
      if (!cj) throw new EditError("The companion lost the transcription; try again.");
      if (cj.state !== "done") throw new EditError(cj.error ?? "The transcription was cancelled.");
      const out = cj.output as unknown as TranscribeOutput;
      const data = JSON.parse(await (await getFile(ep, out.transcript, fetchImpl)).text()) as WhisperData;
      await deps.companion.request("jobs/remove", { id_job: id }).catch(() => undefined);
      return { data, metrics: cj.metrics };
    } finally {
      hold(holdKey, false);
    }
  }

  function transcribe(clipId: number, onProgress?: (cj: CompanionJob) => void): Promise<Transcript> {
    const running = transcribing.get(clipId);
    if (running) return running;
    const p = (async () => {
      const have = await getTranscript(clipId);
      if (have) return have;
      const blob = await db.get<Blob>("clipBlobs", clipId);
      if (!blob) throw new EditError("The original clip file is missing.");
      const { data, metrics } = await runWhisper(trId(clipId), blob, -clipId, onProgress);
      const t = await putTranscript({
        clip_id: clipId,
        model: data.model,
        language: data.language ?? null,
        duration: data.duration,
        segments: data.segments ?? [],
        dropped: data.dropped ?? [],
        metrics: metrics ? { wall_ms: metrics.wall_ms, cpu_ms: metrics.cpu_ms, peak_rss_bytes: metrics.peak_rss_bytes } : null,
        created_at: new Date().toISOString(),
      });
      log("transcript_done", { clip: clipId, segments: t.segments.length, dropped: t.dropped.length, ...(metrics ?? {}) });
      return t;
    })();
    transcribing.set(clipId, p);
    void p.finally(() => transcribing.delete(clipId)).catch(() => undefined);
    return p;
  }

  const sourceRuns = new Map<number, Promise<SourceFile>>();
  /**
   * 4.5: transcript of a whole authorized source (Clipper). Without the companion or Whisper the
   * source is marked "unavailable" and its segments simply have no speech excerpts.
   */
  function transcribeSource(sourceId: number): Promise<SourceFile> {
    const running = sourceRuns.get(sourceId);
    if (running) return running;
    const p = (async () => {
      let s = await db.get<SourceFile>("sources", sourceId);
      if (!s) throw new EditError("That source file no longer exists.");
      if (s.transcript_status === "done") return s;
      const blob = await sourceBlob(sourceId);
      if (!blob) throw new EditError("The source file is no longer stored.");
      const there = await deps.companion.endpoint().then(() => true, () => false);
      if (!there) return updateSource(sourceId, { transcript_status: "unavailable", transcript_error: "The companion isn't connected, so there are no speech excerpts." });
      s = await updateSource(sourceId, { transcript_status: "running", transcript_error: null });
      try {
        const { data } = await runWhisper(`sh-trs-${sourceId}`, blob, -1_000_000 - sourceId);
        return await updateSource(sourceId, {
          transcript_status: "done",
          transcript_error: null,
          transcript: { model: data.model, language: data.language ?? null, segments: data.segments ?? [], dropped: (data.dropped ?? []).length, created_at: new Date().toISOString() },
        });
      } catch (e) {
        return updateSource(sourceId, { transcript_status: "failed", transcript_error: e instanceof Error ? e.message : String(e) });
      }
    })();
    sourceRuns.set(sourceId, p);
    void p.finally(() => sourceRuns.delete(sourceId)).catch(() => undefined);
    return p;
  }

  /** Captions on: transcribe first, then put Whisper's words into the plan (in seconds of the Short). */
  async function withCaptions(job: EditJob): Promise<EditJob> {
    await patchEditJob(job.id, { state: "transcribing", step: EDIT_STATE_LABEL.transcribing, progress: 0, error: null });
    const t = await transcribe(job.clip_id, (cj) => void patchEditJob(job.id, { step: cj.step || EDIT_STATE_LABEL.transcribing, progress: cj.progress ?? 0 }));
    const captions = captionsFor(
      t.segments.flatMap((s) => s.words),
      job.plan.trim.start,
      job.plan.trim.end,
    );
    const notes = [...job.plan.notes.filter((n) => !CAPTION_NOTE.test(n)), captions.length ? `Captions: ${captions.length} lines of what is said (Whisper, on this computer).` : "No speech was found, so there are no captions."];
    return (await patchEditJob(job.id, { plan: { ...job.plan, captions, notes } }))!;
  }

  async function submit(job: EditJob): Promise<EditJob> {
    const blob = await db.get<Blob>("clipBlobs", job.clip_id);
    if (!blob) return (await patchEditJob(job.id, { state: "failed", step: EDIT_STATE_LABEL.failed, error: "The original clip file is missing." }))!;
    try {
      if (job.plan.captions) {
        hold(job.id, true);
        job = await withCaptions(job);
      }
    } catch (e) {
      hold(job.id, false);
      return (await patchEditJob(job.id, { state: "failed", step: EDIT_STATE_LABEL.failed, error: `Captions: ${e instanceof Error ? e.message : String(e)}` }))!;
    }
    await patchEditJob(job.id, { state: "uploading", step: EDIT_STATE_LABEL.uploading, progress: 0, error: null });
    try {
      const ep = await deps.companion.endpoint();
      await putFile(ep, inputName(job), blob, fetchImpl);
      hold(job.id, true);
      const cj = await deps.companion.request<CompanionJob>("edit/start", { id_job: job.companion_id, input: inputName(job), plan: job.plan });
      return (await apply(job.id, cj)) ?? job;
    } catch (e) {
      hold(job.id, false);
      const msg = e instanceof Error ? e.message : String(e);
      return (await patchEditJob(job.id, { state: "failed", step: EDIT_STATE_LABEL.failed, error: /Unknown request/i.test(msg) ? "This companion can't edit yet. Update it (run the installer from the new StreamHunter folder)." : msg }))!;
    }
  }

  /** Mirror a companion job into the local row; import the Short when it's done. */
  async function apply(localId: number, cj: CompanionJob): Promise<EditJob | undefined> {
    const job = await getEditJob(localId);
    if (!job || EDIT_TERMINAL.includes(job.state)) return job;
    if (cj.state === "done") return importShort(job, cj);
    if (cj.state === "failed" || cj.state === "cancelled") {
      hold(job.id, false);
      void deps.companion.request("jobs/remove", { id_job: job.companion_id }).catch(() => undefined);
      return patchEditJob(job.id, { state: cj.state, step: EDIT_STATE_LABEL[cj.state], error: cj.error, progress: 0 });
    }
    hold(job.id, true);
    const state = cj.state as EditState;
    return patchEditJob(job.id, { state, step: cj.step || EDIT_STATE_LABEL[state] || "", progress: cj.progress ?? 0, error: null });
  }

  async function importShort(job: EditJob, cj: CompanionJob): Promise<EditJob | undefined> {
    if (importing.has(job.id)) return job;
    importing.add(job.id);
    try {
      await patchEditJob(job.id, { state: "importing", step: EDIT_STATE_LABEL.importing, progress: 1 });
      const ep = await deps.companion.endpoint();
      const out = cj.output!;
      const video = await getFile(ep, out.video, fetchImpl);
      if (video.size !== out.size) throw new EditError("The edited Short arrived incomplete.");
      const thumb = out.thumbnail ? await getFile(ep, out.thumbnail, fetchImpl).catch(() => null) : null;
      const vertical = (await listAssets(job.clip_id)).find((a) => a.kind === "vertical");
      // One edited Short per clip: a newer edit replaces the older one.
      for (const old of (await listAssets(job.clip_id)).filter((a) => a.kind === "edited_vertical")) {
        await db.delete("assetBlobs", old.id);
        await db.delete("assetBlobs", -old.id);
        await db.delete("assets", old.id);
      }
      const now = new Date().toISOString();
      const asset = await db.put<Asset>("assets", {
        id: undefined as unknown as number,
        clip_id: job.clip_id,
        kind: "edited_vertical",
        layout: vertical?.layout ?? null,
        layout_source: vertical?.layout_source ?? null,
        used_layout: vertical?.used_layout ?? null,
        status: "ready",
        error: null,
        attempts: 0,
        progress: 1,
        width: out.width,
        height: out.height,
        duration_seconds: out.duration,
        size_bytes: video.size,
        reused_original: false,
        has_thumbnail: Boolean(thumb),
        notes: cj.notes ?? [],
        template: job.template,
        edit_job_id: job.id,
        metrics: cj.metrics,
        created_at: now,
        updated_at: now,
      });
      await db.putBlob(asset.id, new Blob([video], { type: "video/mp4" }), "assetBlobs");
      if (thumb) await db.putBlob(-asset.id, new Blob([thumb], { type: "image/jpeg" }), "assetBlobs");
      const done = await patchEditJob(job.id, { state: "done", step: EDIT_STATE_LABEL.done, progress: 1, error: null, asset_id: asset.id, metrics: cj.metrics, notes: cj.notes ?? [] });
      await deps.companion.request("jobs/remove", { id_job: job.companion_id }).catch(() => undefined);
      log("edit_done", { job: job.id, clip: job.clip_id, ...cj.metrics });
      return done;
    } catch (e) {
      log("edit_import_failed", { job: job.id, error: e instanceof Error ? e.message : String(e) });
      return patchEditJob(job.id, { state: "failed", step: EDIT_STATE_LABEL.failed, error: `Couldn't save the edited Short: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      importing.delete(job.id);
      hold(job.id, false);
    }
  }

  async function pollActive() {
    for (const j of await listEditJobs()) {
      if (EDIT_TERMINAL.includes(j.state) || j.state === "uploading" || j.state === "transcribing") continue;
      const cj = await deps.companion.request<CompanionJob | null>("jobs/get", { id_job: j.companion_id }).catch(() => undefined);
      if (cj === null) await submit(j); // the companion lost it (its folder was cleared): send it again
      else if (cj) await apply(j.id, cj);
    }
  }

  deps.companion.onEvent((e) => {
    if (e.event !== "job" || !e.job.id.startsWith("sh-edit-")) return;
    const id = Number(e.job.id.slice("sh-edit-".length));
    if (Number.isInteger(id)) void apply(id, e.job).catch((err) => log("edit_event_failed", { id, error: String(err) }));
  });

  async function waitForRecording(job: EditJob, settings: Settings): Promise<boolean> {
    if (!settings.editing.pauseWhileRecording || !(await deps.isRecording())) return false;
    await patchEditJob(job.id, { state: "uploading", step: "Waiting until recording stops", progress: 0 });
    return true;
  }

  return {
    /**
     * Edit a clip. "auto" only when its score reaches autoFrom (quietly skipped otherwise or when the
     * companion isn't there); "manual" from offerFrom. The same clip and options is never edited twice.
     */
    async edit(clipId: number, settings: Settings, trigger: "auto" | "manual"): Promise<EditJob | null> {
      const clip = await db.get<ContentClip>("clips", clipId);
      if (!clip) throw new EditError("That clip no longer exists.");
      const score = clip.viral?.total ?? null;
      const decision = decideEdit(score, settings.editing);
      if (trigger === "auto" && decision !== "auto") return null;
      if (trigger === "manual") {
        if (!settings.editing.enabled) throw new EditError("Automatic editing is turned off in Settings → Editing.");
        if (decision === "none") throw new EditError(`Clips are edited from a score of ${settings.editing.offerFrom}${score === null ? "; this clip has no score yet" : `; this one has ${score}`}.`);
      }
      const vertical = (await listAssets(clipId)).find((a) => a.kind === "vertical" && a.status === "ready");
      const peakSec = clip.peak_at ? Math.max(0, (Date.parse(clip.peak_at) - Date.parse(clip.started_at)) / 1000) : null;
      const plan = buildEditPlan(
        { width: clip.width ?? 0, height: clip.height ?? 0, duration: clip.duration_seconds ?? 0, peakSec: Number.isFinite(peakSec) ? peakSec : null, layout: vertical?.layout ?? null, actionPath: vertical?.action_path ?? null },
        settings.editing,
      );
      if ("error" in plan) {
        if (trigger === "auto") return null;
        throw new EditError(plan.error);
      }
      if (trigger === "auto") {
        // Only when the companion is there; nothing is queued for a companion that isn't installed.
        const ok = await deps.companion.endpoint().then(() => true, () => false);
        if (!ok) return null;
      }
      const key = dedupeKey(clipId, plan);
      const existing = await editJobByKey(key);
      let job: EditJob;
      if (existing) {
        if (existing.state !== "failed" && existing.state !== "cancelled") return existing;
        if (trigger === "auto") return existing; // a failed automatic edit is retried by you, not in a loop
        job = (await patchEditJob(existing.id, { trigger, score, plan, state: "uploading", step: EDIT_STATE_LABEL.uploading, progress: 0, error: null }))!;
      } else job = await createEditJob({ clip_id: clipId, trigger, score, plan, dedupe_key: key });
      if (await waitForRecording(job, settings)) return (await getEditJob(job.id))!;
      return submit(job);
    },
    async cancel(id: number): Promise<EditJob | undefined> {
      const job = await getEditJob(id);
      if (!job || EDIT_TERMINAL.includes(job.state)) return job;
      if (job.state !== "uploading") await deps.companion.request("jobs/cancel", { id_job: job.companion_id }).catch(() => undefined);
      void deps.companion.request("jobs/remove", { id_job: job.companion_id }).catch(() => undefined);
      hold(id, false);
      return patchEditJob(id, { state: "cancelled", step: EDIT_STATE_LABEL.cancelled, progress: 0 });
    },
    async retry(id: number): Promise<EditJob> {
      const job = await getEditJob(id);
      if (!job) throw new EditError("That edit no longer exists.");
      if (job.state !== "failed" && job.state !== "cancelled") return job;
      return submit(job);
    },
    /** Worker start / alarm: continue edits that were waiting or running. */
    async resume(settings: Settings): Promise<void> {
      const jobs = (await listEditJobs()).filter((j) => !EDIT_TERMINAL.includes(j.state));
      if (!jobs.length) return;
      const recording = settings.editing.pauseWhileRecording && (await deps.isRecording());
      for (const j of jobs) {
        if (j.state === "uploading" || j.state === "transcribing") {
          if (!recording) await submit(j);
        } else if (j.state === "importing") {
          const cj = await deps.companion.request<CompanionJob | null>("jobs/get", { id_job: j.companion_id }).catch(() => undefined);
          if (cj?.state === "done") await importShort(j, cj);
          else if (cj === null) await submit(j);
        } else hold(j.id, true);
      }
      await pollActive();
    },
    pollActive,
    /** 4.5: speech of a whole source (if the companion is there), then its candidate segments. */
    async segments(sourceId: number): Promise<Segment[]> {
      const s = await db.get<SourceFile>("sources", sourceId);
      if (!s) throw new EditError("That source file no longer exists.");
      if (s.analysis !== "analyzed") throw new EditError("Analyse the file first.");
      return saveSegments(await transcribeSource(sourceId));
    },
    /** 4.4: transcribe a clip now (Library → Transcribe); the stored transcript if there is one. */
    async transcribe(clipId: number): Promise<Transcript> {
      if (!(await db.get<ContentClip>("clips", clipId))) throw new EditError("That clip no longer exists.");
      return transcribe(clipId);
    },
  };
}

export type EditingManager = ReturnType<typeof createEditingManager>;
