/**
 * 4.0 edit jobs (DB v5 "editJobs"): one row per edit of a clip, mirrored from the companion's queue.
 * The finished Short is an "edited_vertical" asset; the original clip is never changed.
 */
import { db } from "./db";
import type { EditPlan } from "@/editing/rules";
import type { EditMetrics } from "./assets";

export type EditState = "uploading" | "queued" | "probing" | "encoding" | "validating" | "importing" | "done" | "failed" | "cancelled";
export const EDIT_TERMINAL: readonly EditState[] = ["done", "failed", "cancelled"];
export const EDIT_STATE_LABEL: Record<EditState, string> = {
  uploading: "Sending to the companion",
  queued: "Waiting",
  probing: "Checking the clip",
  encoding: "Editing",
  validating: "Checking the Short",
  importing: "Saving the Short",
  done: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

export interface EditJob {
  id: number;
  clip_id: number;
  /** "auto" (score ≥ autoFrom) or "manual" (you clicked Edit). */
  trigger: "auto" | "manual";
  score: number | null;
  template: string;
  dedupe_key: string;
  plan: EditPlan;
  state: EditState;
  step: string;
  progress: number;
  error: string | null;
  /** The companion's job id ("sh-edit-<id>"). */
  companion_id: string;
  /** The edited Short (assets row) once imported. */
  asset_id: number | null;
  metrics: EditMetrics | null;
  notes: string[];
  created_at: string;
  updated_at: string;
}

export const companionJobId = (id: number) => `sh-edit-${id}`;

export async function listEditJobs(clip?: number): Promise<EditJob[]> {
  const all = clip === undefined ? await db.all<EditJob>("editJobs") : await db.byIndex<EditJob>("editJobs", "clip", clip);
  return all.sort((a, b) => b.id - a.id);
}
export const getEditJob = (id: number) => db.get<EditJob>("editJobs", id);
export const editJobByKey = (key: string) => db.oneByIndex<EditJob>("editJobs", "dedupe", key);

export async function createEditJob(v: Pick<EditJob, "clip_id" | "trigger" | "score" | "plan" | "dedupe_key">, now = new Date()): Promise<EditJob> {
  const row = await db.put<EditJob>("editJobs", {
    id: undefined as unknown as number,
    ...v,
    template: v.plan.template,
    state: "uploading",
    step: EDIT_STATE_LABEL.uploading,
    progress: 0,
    error: null,
    companion_id: "",
    asset_id: null,
    metrics: null,
    notes: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  return db.put<EditJob>("editJobs", { ...row, companion_id: companionJobId(row.id) });
}

export async function patchEditJob(id: number, patch: Partial<Omit<EditJob, "id" | "clip_id">>, now = new Date()): Promise<EditJob | undefined> {
  const j = await getEditJob(id);
  if (!j) return undefined;
  return db.put<EditJob>("editJobs", { ...j, ...patch, updated_at: now.toISOString() });
}

export async function deleteEditJobsOf(clip: number): Promise<void> {
  for (const j of await listEditJobs(clip)) await db.delete("editJobs", j.id);
}
