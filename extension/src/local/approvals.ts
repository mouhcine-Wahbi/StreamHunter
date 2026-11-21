/**
 * Recording approvals (3.0): StreamHunter never records a stream you haven't approved.
 *
 * When a streamer you selected for recording ("Ask to record") goes live, one approval request is
 * created for that broadcast. It is tied to the broadcast's identity (`Streamer.broadcast_id`) and
 * expires when that broadcast ends, so an approval never carries over to a later stream. There is
 * exactly one request per broadcast: a decision is never asked twice, except when you choose
 * "Remind me later".
 *
 * The rules (`reconcile`, `decide`, `approvedIds`) are pure and tested; `createApprovals` persists them
 * in chrome.storage.local (small, and every dashboard page sees changes immediately).
 */
import type { Platform, Streamer } from "@/types/api";

export const APPROVALS_KEY = "sh.approvals";

export type ApprovalStatus = "pending" | "snoozed" | "approved" | "declined" | "expired";
export type ApprovalAction = "approve" | "decline" | "remind" | "stop";

export interface Approval {
  /** `${streamerId}|${broadcastId}`: one request per broadcast. */
  id: string;
  streamerId: number;
  streamerName: string;
  platform: Platform;
  username: string;
  broadcastId: string;
  title: string | null;
  category: string | null;
  viewers: number | null;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Snoozed: when to ask again. */
  remindAt: string | null;
  /** How many times you were notified about it (1, or more after "Remind me later"). */
  notifications: number;
  /** Set once the request is closed by the broadcast ending (or the streamer being removed). */
  endedAt: string | null;
  /** Why it was closed or declined, in plain words. */
  note: string | null;
}

export interface ApprovalStore {
  items: Approval[];
}

/** Closed requests kept as history. */
export const HISTORY_LIMIT = 200;

const OPEN: ApprovalStatus[] = ["pending", "snoozed", "approved", "declined"];
const isOpen = (a: Approval) => OPEN.includes(a.status) && a.endedAt === null;

export const approvalId = (streamerId: number, broadcastId: string) => `${streamerId}|${broadcastId}`;

/** Streamers that should be asked about: on your list, live, with a known broadcast, "Ask to record" on. */
export const wantsApproval = (s: Streamer) => s.monitoring_enabled && Boolean(s.auto_record) && s.is_live === true && Boolean(s.broadcast_id);

export interface ReconcileResult {
  items: Approval[];
  /** New requests and due reminders: notify about these. */
  notify: Approval[];
  /** Requests that just closed because their broadcast ended. */
  expired: Approval[];
}

/**
 * After a live check: open a request for each newly live broadcast, wake due reminders, close
 * requests whose broadcast ended (offline, a new broadcast, removed, or no longer selected).
 */
export function reconcile(items: Approval[], streamers: Streamer[], now: Date): ReconcileResult {
  const at = now.toISOString();
  const byId = new Map(streamers.map((s) => [s.id, s]));
  const out = items.map((a) => ({ ...a }));
  const notify: Approval[] = [];
  const expired: Approval[] = [];

  for (const a of out) {
    if (!isOpen(a)) continue;
    const s = byId.get(a.streamerId);
    const reason = !s
      ? "The streamer was removed from your list."
      : s.is_live !== true
        ? "The broadcast ended."
        : s.broadcast_id !== a.broadcastId
          ? "The broadcast ended (a new one started)."
          : !s.monitoring_enabled
            ? "Live monitoring was turned off for this streamer."
            : !s.auto_record
              ? "Recording requests were turned off for this streamer."
              : null;
    if (!reason) continue;
    if (a.status === "pending" || a.status === "snoozed") {
      a.status = "expired";
      a.note = `Not answered. ${reason}`;
    } else a.note = [a.note, reason].filter(Boolean).join(" ");
    a.endedAt = at;
    a.remindAt = null;
    expired.push(a);
  }

  const known = new Set(out.map((a) => a.id));
  for (const s of streamers.filter(wantsApproval)) {
    const id = approvalId(s.id, s.broadcast_id!);
    if (known.has(id)) continue;
    const a: Approval = {
      id,
      streamerId: s.id,
      streamerName: s.display_name,
      platform: s.platform,
      username: s.username,
      broadcastId: s.broadcast_id!,
      title: s.current_title,
      category: s.current_category,
      viewers: s.viewer_count,
      status: "pending",
      createdAt: at,
      decidedAt: null,
      remindAt: null,
      notifications: 1,
      endedAt: null,
      note: null,
    };
    out.push(a);
    notify.push(a);
  }

  for (const a of out) {
    if (a.status === "snoozed" && a.endedAt === null && a.remindAt && Date.parse(a.remindAt) <= now.getTime()) {
      a.status = "pending";
      a.remindAt = null;
      a.notifications += 1;
      notify.push(a);
    }
    // Keep the newest live details on open requests.
    const s = byId.get(a.streamerId);
    if (isOpen(a) && s && s.broadcast_id === a.broadcastId) Object.assign(a, { title: s.current_title, category: s.current_category, viewers: s.viewer_count, streamerName: s.display_name });
  }
  return { items: prune(out), notify, expired };
}

/** Open requests first (newest first), then the newest closed ones up to HISTORY_LIMIT. */
function prune(items: Approval[]): Approval[] {
  const open = items.filter(isOpen);
  const closed = items.filter((a) => !isOpen(a)).sort((a, b) => (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt));
  return [...open.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), ...closed.slice(0, HISTORY_LIMIT)];
}

export class ApprovalError extends Error {}

/** Your decision on one request. Throws ApprovalError when it no longer applies. */
export function decide(items: Approval[], id: string, action: ApprovalAction, now: Date, remindMinutes: number): Approval[] {
  const out = items.map((a) => ({ ...a }));
  const a = out.find((x) => x.id === id);
  if (!a) throw new ApprovalError("This recording request no longer exists.");
  if (a.endedAt !== null || a.status === "expired") throw new ApprovalError(`${a.streamerName}'s broadcast has ended; this request is closed.`);
  const at = now.toISOString();
  switch (action) {
    case "approve":
      Object.assign(a, { status: "approved", decidedAt: at, remindAt: null, note: null });
      break;
    case "decline":
      Object.assign(a, { status: "declined", decidedAt: at, remindAt: null, note: "Declined by you." });
      break;
    case "remind":
      if (a.status === "approved") throw new ApprovalError("This stream is already approved.");
      Object.assign(a, { status: "snoozed", remindAt: new Date(now.getTime() + Math.max(1, remindMinutes) * 60_000).toISOString(), note: null });
      break;
    case "stop":
      if (a.status !== "approved") throw new ApprovalError("Only an approved stream can be stopped.");
      Object.assign(a, { status: "declined", decidedAt: at, note: "Recording stopped by you." });
      break;
  }
  return out;
}

/**
 * Streamers whose CURRENT broadcast you approved. Checked against the streamer's live broadcast
 * again, so an approval can never apply to a different stream.
 */
export function approvedIds(items: Approval[], streamers: Streamer[]): Set<number> {
  const live = new Map(streamers.filter((s) => s.is_live === true && s.broadcast_id).map((s) => [s.id, s.broadcast_id!]));
  return new Set(items.filter((a) => a.status === "approved" && a.endedAt === null && live.get(a.streamerId) === a.broadcastId).map((a) => a.streamerId));
}

/** Current request per streamer (open ones only). */
export function openRequestFor(items: Approval[], streamerId: number): Approval | undefined {
  return items.find((a) => a.streamerId === streamerId && isOpen(a));
}

// --- persistence (chrome.storage.local) ------------------------------------------------------------

export async function readApprovals(): Promise<Approval[]> {
  const v = (await chrome.storage.local.get(APPROVALS_KEY))[APPROVALS_KEY] as ApprovalStore | undefined;
  return Array.isArray(v?.items) ? v.items : [];
}

let lock: Promise<unknown> = Promise.resolve();

/** Serialised read-modify-write (the worker handles alarms and clicks concurrently). */
export function mutateApprovals<T>(fn: (items: Approval[]) => { items: Approval[]; result: T } | Promise<{ items: Approval[]; result: T }>): Promise<T> {
  const run = lock.then(async () => {
    const { items, result } = await fn(await readApprovals());
    await chrome.storage.local.set({ [APPROVALS_KEY]: { items } satisfies ApprovalStore });
    return result;
  });
  lock = run.catch(() => undefined);
  return run;
}
