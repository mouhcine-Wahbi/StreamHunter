/**
 * Runs publishing jobs (3.0 phase 7) from the service worker: on the 5-minute publishing alarm,
 * after a clip's content is ready, and after your actions. Each job is checked again every time
 * (rights or accounts may have changed), uploaded once its checks pass, and marked published only
 * on the platform's confirmation. Network and rate-limit errors are retried with backoff up to
 * Settings → Publishing → retries; anything ambiguous (the platform may have posted) is never
 * retried automatically.
 */
import { db } from "@/local/db";
import { assetBlob, listAssets } from "@/local/assets";
import type { ContentClip } from "@/local/content";
import { listJobs, patchJob, publishedToday, type PublishJob } from "@/local/jobs";
import { getCreatorRights, rightsKey, type Rights } from "@/local/rights";
import type { SourceFile } from "@/local/sources";
import { getSettings } from "@/store/storage";
import type { Streamer } from "@/types/api";
import type { Settings } from "@/types/settings";
import { accessToken, AccountError, listAccounts, type AccountView, type Profile } from "./accounts";
import { preflight } from "./checks";
import { confirm, fetchMetrics, PublishError, upload, type ConfirmOutcome } from "./platforms";
import type { Destination } from "@/local/rights";

export interface RunnerDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  token?: (d: Destination) => Promise<{ token: string; profile: Profile }>;
  accounts?: () => Promise<AccountView[]>;
  settings?: () => Promise<Settings>;
  sleep?: (ms: number) => Promise<void>;
  /** How many times to check for confirmation right after an upload before leaving it to the alarm. */
  inlineConfirmTries?: number;
  /** Reads a made file (tests replace it). */
  blob?: (asset: Parameters<typeof assetBlob>[0]) => Promise<Blob | undefined>;
  onPublished?: (job: PublishJob) => void;
  onFailed?: (job: PublishJob) => void;
}

const STALE_UPLOAD_MS = 15 * 60_000;
const CONFIRM_GIVE_UP_MS = 48 * 3600_000;
const METRICS_EVERY_MS = 6 * 3600_000;
const METRICS_FOR_MS = 30 * 24 * 3600_000;

export const backoffMs = (attempt: number) => Math.min(60 * 60_000, 2 ** Math.max(0, attempt - 1) * 2 * 60_000);

/** Rights for the clip's source: the authorized file it was cut from, or the monitored creator. */
export async function rightsForClip(clip: ContentClip & { source_id?: number }): Promise<Rights | null> {
  if (clip.source_id) return (await db.get<SourceFile>("sources", clip.source_id))?.rights ?? null;
  if (!clip.streamer_id) return null;
  const s = await db.get<Streamer>("streamers", clip.streamer_id);
  return s ? getCreatorRights(rightsKey(s.platform, s.platform_user_id)) : null;
}

let running: Promise<{ processed: number }> | null = null;
const inflight = new Set<number>();

export function runPublishing(deps: RunnerDeps = {}): Promise<{ processed: number }> {
  if (running) return running;
  running = run(deps).finally(() => (running = null));
  return running;
}

async function run(deps: RunnerDeps): Promise<{ processed: number }> {
  const now = deps.now ?? (() => new Date());
  const settings = await (deps.settings ?? getSettings)();
  const accounts = await (deps.accounts ?? listAccounts)();
  const tokenFor = deps.token ?? ((d: Destination) => accessToken(d, { fetchImpl: deps.fetchImpl }));
  let processed = 0;

  for (const job of await listJobs()) {
    if (inflight.has(job.id)) continue;
    const t = now().getTime();
    // A worker that stopped mid-upload leaves "uploading" behind.
    if (job.state === "uploading" && t - Date.parse(job.updated_at) > STALE_UPLOAD_MS) {
      await failJob(job, job.posting ? new PublishError("Interrupted while the platform was creating the post; check your account before retrying.", false, true) : new PublishError("The upload was interrupted.", true), settings, now(), deps);
      continue;
    }
    const due = !job.next_at || Date.parse(job.next_at) <= t;
    if (job.state === "confirming" && due) {
      processed++;
      await confirmJob(job, tokenFor, settings, now, deps);
    } else if ((["queued", "needs_approval", "waiting", "blocked"].includes(job.state) && due) || (job.state === "failed" && job.retryable && due && job.attempts <= settings.publishing.maxRetries)) {
      processed++;
      await attempt(job, accounts, tokenFor, settings, now, deps);
    }
  }
  await refreshMetrics(tokenFor, now(), deps);
  return { processed };
}

async function attempt(job: PublishJob, accounts: AccountView[], tokenFor: NonNullable<RunnerDeps["token"]>, settings: Settings, now: () => Date, deps: RunnerDeps) {
  const clip = await db.get<ContentClip & { source_id?: number }>("clips", job.clip_id);
  if (!clip) {
    await patchJob(job.id, { state: "cancelled", reason: "The clip was deleted." }, undefined, now());
    return;
  }
  const account = accounts.find((a) => a.destination === job.destination)!;
  const pf = preflight({
    job,
    clip,
    assets: await listAssets(clip.id),
    rights: await rightsForClip(clip),
    account,
    settings,
    siblings: await listJobs({ clipId: clip.id }),
    publishedToday: await publishedToday(job.destination, now()),
    now: now(),
  });
  if (pf.action === "wait") return void (await patchJob(job.id, { state: "waiting", reason: pf.reason, next_at: pf.until ?? null }, undefined, now()));
  if (pf.action === "block") return void (await patchJob(job.id, { state: "blocked", reason: pf.reason, next_at: null }, undefined, now()));
  if (pf.action === "approval") return void (await patchJob(job.id, { state: "needs_approval", reason: pf.reason, next_at: null }, undefined, now()));

  inflight.add(job.id);
  try {
    let j = await patchJob(job.id, { state: "uploading", reason: null, asset_id: pf.asset.id, attempts: job.attempts + 1, progress: 0, next_at: null }, `Attempt ${job.attempts + 1}`, now());
    try {
      const { token, profile } = await tokenFor(job.destination);
      const blob = await (deps.blob ?? assetBlob)(pf.asset);
      if (!blob) throw new PublishError("The made file is missing; remake it.", false);
      let lastProgress = 0;
      const out = await upload(job.destination, {
        blob,
        meta: clip.metadata!.byDestination[job.destination],
        durationSec: pf.asset.duration_seconds ?? clip.duration_seconds ?? 0,
        settings,
        token,
        profile,
        fetchImpl: deps.fetchImpl,
        onProgress: (p) => {
          if (p - lastProgress >= 0.25 || p === 1) {
            lastProgress = p;
            void patchJob(job.id, { progress: p }, undefined, now());
          }
        },
        beforePost: async () => void (await patchJob(job.id, { posting: true }, undefined, now())),
      });
      if (out.kind === "published") {
        j = await patchJob(job.id, { state: "published", platform_id: out.platformId, url: out.url, published_at: now().toISOString(), posting: false, progress: 1, reason: null }, "Confirmed by the platform", now());
        deps.onPublished?.(j);
        return;
      }
      j = await patchJob(job.id, { state: "confirming", ref: out.ref, reason: out.note, progress: 1, next_at: null }, out.note, now());
    } catch (e) {
      await failJob(j, e, settings, now(), deps);
      return;
    }
    // Check right away a few times; the alarm continues after that.
    const tries = deps.inlineConfirmTries ?? 6;
    for (let k = 0; k < tries && j.state === "confirming"; k++) {
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(10_000);
      j = await confirmJob(j, tokenFor, settings, now, deps);
    }
  } finally {
    inflight.delete(job.id);
  }
}

async function confirmJob(job: PublishJob, tokenFor: NonNullable<RunnerDeps["token"]>, settings: Settings, now: () => Date, deps: RunnerDeps): Promise<PublishJob> {
  const clip = await db.get<ContentClip>("clips", job.clip_id);
  let out: ConfirmOutcome;
  try {
    const { token, profile } = await tokenFor(job.destination);
    out = await confirm(job.destination, job.ref!, {
      meta: clip?.metadata?.byDestination[job.destination] ?? { title: "", description: "", hashtags: [] },
      token,
      profile,
      fetchImpl: deps.fetchImpl,
      beforePost: async () => void (await patchJob(job.id, { posting: true }, undefined, now())),
    });
  } catch (e) {
    if (e instanceof PublishError && e.ambiguous) return failJob(job, e, settings, now(), deps);
    const msg = e instanceof Error ? e.message : "error";
    const tooLong = now().getTime() - Date.parse([...job.history].reverse().find((h) => h.state === "confirming")?.at ?? job.updated_at) > CONFIRM_GIVE_UP_MS;
    if (tooLong) return failJob(job, new PublishError(`No confirmation from the platform in 48 h (${msg}).`, false), settings, now(), deps);
    return patchJob(job.id, { reason: `Couldn't check yet: ${msg}`, next_at: new Date(now().getTime() + 5 * 60_000).toISOString() }, undefined, now());
  }
  if (out.kind === "published") {
    const j = await patchJob(job.id, { state: "published", platform_id: out.platformId, url: out.url, published_at: now().toISOString(), posting: false, reason: null }, "Confirmed by the platform", now());
    deps.onPublished?.(j);
    return j;
  }
  if (out.kind === "failed") return failJob(job, new PublishError(out.reason, false), settings, now(), deps);
  return patchJob(job.id, { reason: out.note, next_at: new Date(now().getTime() + Math.max(60, out.afterSec ?? 0) * 1000).toISOString() }, undefined, now());
}

async function failJob(job: PublishJob, e: unknown, settings: Settings, now: Date, deps: RunnerDeps): Promise<PublishJob> {
  if (e instanceof AccountError) {
    return patchJob(job.id, { state: "blocked", reason: e.message, next_at: null, posting: false }, undefined, now);
  }
  const pe = e instanceof PublishError ? e : new PublishError(e instanceof Error ? e.message : "Publishing failed.", false);
  const canRetry = pe.retryable && !pe.ambiguous && job.attempts <= settings.publishing.maxRetries;
  const reason = canRetry ? `${pe.message} Retrying (attempt ${job.attempts + 1} of ${settings.publishing.maxRetries + 1}).` : pe.message;
  const j = await patchJob(job.id, { state: "failed", reason, retryable: canRetry, next_at: canRetry ? new Date(now.getTime() + backoffMs(job.attempts)).toISOString() : null, posting: pe.ambiguous }, undefined, now);
  if (!canRetry) deps.onFailed?.(j);
  return j;
}

async function refreshMetrics(tokenFor: NonNullable<RunnerDeps["token"]>, now: Date, deps: RunnerDeps) {
  const due = (await listJobs({ state: "published" }))
    .filter((j) => j.platform_id && j.published_at && now.getTime() - Date.parse(j.published_at) < METRICS_FOR_MS && (!j.metrics || now.getTime() - Date.parse(j.metrics.fetched_at) > METRICS_EVERY_MS))
    .slice(0, 10);
  for (const j of due) {
    try {
      const { token } = await tokenFor(j.destination);
      const m = await fetchMetrics(j.destination, j.platform_id!, token, deps.fetchImpl, now);
      if (m) await patchJob(j.id, { metrics: m }, undefined, now);
    } catch {
      /* metrics are best effort; the next run tries again */
    }
  }
}
