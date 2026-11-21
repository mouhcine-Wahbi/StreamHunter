/**
 * Publishing jobs (3.0 phase 7): one independent job per clip and destination, stored in IndexedDB
 * with its full history. A job reaches "published" only when the platform confirmed the post.
 */
import { db } from "./db";
import type { Destination } from "./rights";
import type { Metrics } from "@/publishing/platforms";

export type JobState =
  | "needs_approval" // medium potential (or auto-publishing off): waiting for you
  | "waiting" // waiting for something that will happen on its own (file, text, tomorrow's limit)
  | "blocked" // a check failed that you must fix (rights, account, destination off…)
  | "queued"
  | "uploading"
  | "confirming" // the platform accepted the file; waiting for its confirmation
  | "published"
  | "failed"
  | "cancelled";

export const JOB_LABEL: Record<JobState, string> = {
  needs_approval: "Needs your approval",
  waiting: "Waiting",
  blocked: "Blocked",
  queued: "Queued",
  uploading: "Uploading",
  confirming: "Confirming with the platform",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};

export interface JobEvent {
  at: string;
  state: JobState;
  note: string | null;
}

export interface PublishJob {
  id: number;
  clip_id: number;
  asset_id: number | null;
  destination: Destination;
  state: JobState;
  reason: string | null;
  /** You approved it (or created it yourself in Publishing Studio). */
  approved: boolean;
  /** Created by automatic publishing. */
  auto: boolean;
  attempts: number;
  retryable: boolean;
  next_at: string | null;
  progress: number;
  /** Platform reference while confirming (YouTube video id, TikTok publish id, X media id). */
  ref: string | null;
  /** Set right before X creates the post: an interrupted job here is never retried blindly. */
  posting: boolean;
  platform_id: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  history: JobEvent[];
  metrics: Metrics | null;
}

export class JobError extends Error {}

const ACTIVE: JobState[] = ["needs_approval", "waiting", "blocked", "queued", "uploading", "confirming"];
export const isActive = (s: JobState) => ACTIVE.includes(s);

export async function listJobs(filter: { clipId?: number; state?: JobState } = {}): Promise<PublishJob[]> {
  const rows = filter.clipId !== undefined ? await db.byIndex<PublishJob>("jobs", "clip", filter.clipId) : await db.all<PublishJob>("jobs");
  return rows.filter((j) => !filter.state || j.state === filter.state).sort((a, b) => b.id - a.id);
}

export async function getJob(id: number): Promise<PublishJob> {
  const j = await db.get<PublishJob>("jobs", id);
  if (!j) throw new JobError("That publishing job no longer exists.");
  return j;
}

/** Updates a job; a state change is added to its history. */
export async function patchJob(id: number, patch: Partial<PublishJob>, note?: string | null, now = new Date()): Promise<PublishJob> {
  const j = await getJob(id);
  const next = { ...j, ...patch, updated_at: now.toISOString() };
  if (patch.state && (patch.state !== j.state || (note && note !== j.reason))) next.history = [...j.history, { at: now.toISOString(), state: patch.state, note: note ?? patch.reason ?? null }].slice(-50);
  return db.put<PublishJob>("jobs", next);
}

/** One job per clip and destination: returns the active or published one if it exists. */
export async function createJob(clipId: number, destination: Destination, opts: { approved: boolean; auto: boolean }, now = new Date()): Promise<PublishJob> {
  const existing = (await listJobs({ clipId })).find((j) => j.destination === destination && (isActive(j.state) || j.state === "published"));
  if (existing) {
    if (opts.approved && !existing.approved && isActive(existing.state)) return patchJob(existing.id, { approved: true, state: "queued", reason: null }, "Approved by you", now);
    return existing;
  }
  const at = now.toISOString();
  return db.put<PublishJob>("jobs", {
    id: undefined as unknown as number,
    clip_id: clipId,
    asset_id: null,
    destination,
    state: "queued",
    reason: null,
    approved: opts.approved,
    auto: opts.auto,
    attempts: 0,
    retryable: false,
    next_at: null,
    progress: 0,
    ref: null,
    posting: false,
    platform_id: null,
    url: null,
    created_at: at,
    updated_at: at,
    published_at: null,
    history: [{ at, state: "queued", note: opts.auto ? "Created by automatic publishing" : "Created by you" }],
    metrics: null,
  });
}

export async function approveJob(id: number, now = new Date()): Promise<PublishJob> {
  const j = await getJob(id);
  if (!["needs_approval", "blocked", "waiting", "queued"].includes(j.state)) throw new JobError(`Can't approve a job that is ${JOB_LABEL[j.state].toLowerCase()}.`);
  return patchJob(id, { approved: true, state: "queued", reason: null, next_at: null }, "Approved by you", now);
}

export async function cancelJob(id: number, now = new Date()): Promise<PublishJob> {
  const j = await getJob(id);
  if (j.state === "uploading" || j.state === "confirming") throw new JobError("The platform already has this upload; it can't be cancelled from here.");
  if (j.state === "published" || j.state === "cancelled") throw new JobError(`This job is already ${JOB_LABEL[j.state].toLowerCase()}.`);
  return patchJob(id, { state: "cancelled", reason: "Cancelled by you", next_at: null }, "Cancelled by you", now);
}

/** Try again now (resets the attempt count). Counts as your approval. */
export async function retryJob(id: number, now = new Date()): Promise<PublishJob> {
  const j = await getJob(id);
  if (!["failed", "blocked", "waiting"].includes(j.state)) throw new JobError(`Only failed, blocked or waiting jobs can be retried (this one is ${JOB_LABEL[j.state].toLowerCase()}).`);
  return patchJob(id, { state: "queued", attempts: 0, next_at: null, reason: null, posting: false, approved: true }, "Retry requested by you", now);
}

/** Published by destination since local midnight (the daily limit). */
export async function publishedToday(destination: Destination, now = new Date()): Promise<number> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return (await db.all<PublishJob>("jobs")).filter((j) => j.destination === destination && j.state === "published" && j.published_at && Date.parse(j.published_at) >= midnight.getTime()).length;
}
