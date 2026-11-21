/**
 * Recording approvals in the worker: after each live check, open one request per newly live
 * broadcast of a selected streamer and notify you; apply your decisions. The rules are in
 * local/approvals.ts.
 */
import { db } from "@/local/db";
import { decide, mutateApprovals, reconcile, type Approval, type ApprovalAction, type ReconcileResult } from "@/local/approvals";
import type { Streamer } from "@/types/api";
import type { Settings } from "@/types/settings";
import { APPROVAL_PREFIX, notifyApprovalRequests } from "./notifications";

export interface ApprovalDeps {
  now: () => Date;
  notify: (list: Approval[], settings: Settings) => Promise<void>;
  /** Remove the desktop notification of a request that was answered or closed. */
  clear: (approvalId: string) => Promise<void>;
}

export const defaultApprovalDeps: ApprovalDeps = {
  now: () => new Date(),
  notify: notifyApprovalRequests,
  clear: async (id) => void (await chrome.notifications?.clear(`${APPROVAL_PREFIX}${id}`).catch(() => undefined)),
};

export function createApprovalManager(deps: ApprovalDeps = defaultApprovalDeps) {
  /** After a live check (monitoring on). Returns what changed. */
  async function afterCheck(settings: Settings): Promise<ReconcileResult> {
    const now = deps.now();
    const streamers = await db.all<Streamer>("streamers");
    const r = await mutateApprovals((items) => {
      const res = reconcile(items, streamers, now);
      return { items: res.items, result: res };
    });
    for (const a of r.expired) await deps.clear(a.id);
    if (r.notify.length) await deps.notify(r.notify, settings);
    return r;
  }

  /** Your decision (dashboard or notification button). */
  async function apply(id: string, action: ApprovalAction, settings: Settings): Promise<Approval> {
    const now = deps.now();
    const a = await mutateApprovals((items) => {
      const next = decide(items, id, action, now, settings.notifications.remindMinutes);
      return { items: next, result: next.find((x) => x.id === id)! };
    });
    await deps.clear(id); // answered here or in the notification: it's no longer a question
    return a;
  }

  return { afterCheck, apply };
}

export type ApprovalManager = ReturnType<typeof createApprovalManager>;
