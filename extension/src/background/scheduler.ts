/**
 * Hybrid monitoring scheduler (pure: no Chrome, no storage, fully testable).
 *
 * Discovery (live checks) feeds it the monitoring list; it decides which live streamers the recorder
 * slots record, and explains every decision.
 *
 * Priority (0–100) = weighted average of five parts, each 0–100:
 *   potential   - this streamer's own record here: clips per recorded hour and their average
 *                 score (neutral 50 until there are 10 minutes of recording to judge from);
 *   activity    - moments found for this streamer in the last 30 minutes (chat, viewers, capture);
 *   growth      - viewer growth during this broadcast (70%) and audience size (30%, log scale);
 *   user        - your priority (−2…+2) and favourite;
 *   reliability - recent recording failures lower it.
 * These are starting weights, not a proven predictor: every score shows its parts.
 *
 * Assignment: healthy recordings are kept; free slots take the highest-priority eligible streamers;
 * a recording is replaced only if a waiting streamer scores `switchMargin` points more AND the
 * current one has recorded `minRecordMinutes` AND the slot hasn't switched in `cooldownMinutes`
 * AND no clip of it is still being saved. At most one such switch per run.
 *
 * 3.0: only streamers whose current broadcast you approved can get a slot (`approved`). Approved
 * streams wait in the queue, in priority order, until a slot is free.
 */
import type { Streamer } from "@/types/api";

export interface SchedulerWeights {
  potential: number;
  activity: number;
  growth: number;
  user: number;
  reliability: number;
}

export interface SchedulerConfig {
  maxSlots: number;
  weights: SchedulerWeights;
  minRecordMinutes: number;
  cooldownMinutes: number;
  switchMargin: number;
  maxRetries: number;
}

export const DEFAULT_SCHEDULER: Omit<SchedulerConfig, "maxSlots"> = {
  weights: { potential: 45, activity: 20, growth: 15, user: 15, reliability: 5 },
  minRecordMinutes: 10,
  cooldownMinutes: 5,
  // 12: your strongest preference (favourite +2 vs −2 = 13.5 points at the default weights) can
  // replace a recording; a favourite alone over a neutral streamer (+7.5) can't.
  switchMargin: 12,
  maxRetries: 3,
};

/** Retry waits after the 1st, 2nd, 3rd failure (minutes). */
export const RETRY_MINUTES = [2, 5, 15];

/** What StreamHunter knows locally about a streamer's past recordings. */
export interface StreamerHistory {
  recordedSeconds: number;
  clips: number;
  avgClipScore: number | null;
  /** Moments (any origin) in the last 30 minutes. */
  recentMoments: number;
}

export type SchedStreamer = Streamer & {
  viewer_history?: number[];
  /** −2 … +2, set in My Streamers. */
  priority?: number;
  record_failures?: number;
  /** ISO time before which this streamer is not tried again. */
  record_retry_at?: string | null;
  record_error?: string | null;
};

export interface SlotView {
  slot: number;
  streamerId: number | null;
  /** When the slot started recording its current streamer (ISO). */
  assignedAt: string | null;
  /** Clips of the current streamer still waiting for their post-roll. */
  pendingClips: number;
  /** Paused slots keep their streamer but are not reassigned. */
  paused: boolean;
}

export interface PriorityParts {
  potential: number;
  activity: number;
  growth: number;
  user: number;
  reliability: number;
}

export interface Priority {
  streamerId: number;
  total: number;
  parts: PriorityParts;
  /** One plain-language line per part. */
  explain: string[];
}

export type QueueReason = "waiting_for_slot" | "awaiting_approval" | "declined" | "retry_wait" | "gave_up" | "auto_record_off" | "recorded_elsewhere";

export interface QueueEntry {
  streamerId: number;
  name: string;
  total: number | null;
  reason: QueueReason;
  detail: string;
}

export interface SlotDecision {
  slot: number;
  streamerId: number | null;
  action: "keep" | "assign" | "switch" | "release" | "idle";
  detail: string;
}

export interface SchedulePlan {
  priorities: Priority[];
  decisions: SlotDecision[];
  /** Live streamers that are not being recorded, with why. */
  queue: QueueEntry[];
}

const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export function priorityOf(s: SchedStreamer, h: StreamerHistory | undefined, w: SchedulerWeights, now: number): Priority {
  const explain: string[] = [];
  // potential
  let potential = 50;
  if (h && h.recordedSeconds >= 600) {
    const perHour = h.clips / (h.recordedSeconds / 3600);
    potential = clamp(Math.min(100, perHour * 20) * 0.6 + (h.avgClipScore ?? 0) * 0.4);
    explain.push(`Highlight potential ${potential}: ${perHour.toFixed(1)} clips per recorded hour here${h.avgClipScore !== null ? `, average score ${Math.round(h.avgClipScore)}` : ""}.`);
  } else explain.push("Highlight potential 50: not enough recording history yet (neutral, so new streamers get a chance).");
  // activity
  const moments = h?.recentMoments ?? 0;
  const activity = clamp([0, 40, 70, 100][Math.min(3, moments)]!);
  explain.push(`Activity ${activity}: ${moments} moment${moments === 1 ? "" : "s"} detected in the last 30 minutes.`);
  // growth
  const hist = s.viewer_history ?? [];
  const viewers = s.viewer_count ?? null;
  let growthPart = 0;
  if (viewers !== null && hist.length >= 2) {
    const base = median(hist.slice(0, -1));
    growthPart = base > 0 ? clamp(((viewers - base) / base / 0.5) * 100) : 0;
  }
  const size = viewers !== null && viewers > 0 ? clamp((Math.log10(viewers) / 5) * 100) : 0;
  const growth = clamp(growthPart * 0.7 + size * 0.3);
  explain.push(
    viewers === null
      ? "Viewer growth 0: the platform gave no viewer count."
      : `Viewer growth ${growth}: ${viewers.toLocaleString("en")} viewers${hist.length >= 2 ? `, ${growthPart > 0 ? "growing" : "not growing"} this broadcast` : ""}.`,
  );
  // user
  const pr = Math.max(-2, Math.min(2, Math.round(s.priority ?? 0)));
  const user = clamp(50 + pr * 20 + (s.is_favorite ? 30 : 0));
  explain.push(`Your priority ${user}: ${pr > 0 ? `+${pr}` : pr}${s.is_favorite ? ", favourite" : ""}.`);
  // reliability
  const fails = s.record_failures ?? 0;
  const waiting = s.record_retry_at ? Date.parse(s.record_retry_at) > now : false;
  const reliability = clamp(100 - fails * 30);
  explain.push(fails ? `Reliability ${reliability}: ${fails} recent recording failure${fails === 1 ? "" : "s"}${waiting ? ", waiting to retry" : ""}.` : "Reliability 100: no recent recording failures.");

  const parts = { potential, activity, growth, user, reliability };
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const total = clamp((potential * w.potential + activity * w.activity + growth * w.growth + user * w.user + reliability * w.reliability) / sum);
  return { streamerId: s.id, total, parts, explain };
}

const isLive = (s: SchedStreamer) => s.monitoring_enabled && s.is_live === true;

export interface PlanInput {
  /** Streamers whose current broadcast you approved. Nothing else is ever recorded. */
  approved: ReadonlySet<number>;
  /** Streamers whose current request you declined (shown as such in the queue). */
  declined?: ReadonlySet<number>;
  /** Streamers recorded by manual captures (never recorded twice). */
  excludeIds?: ReadonlySet<number>;
  /** Slot → ISO time of its last switch (cooldown). */
  lastSwitch?: ReadonlyMap<number, string>;
}

export function plan(
  streamers: SchedStreamer[],
  history: Map<number, StreamerHistory>,
  slots: SlotView[],
  cfg: SchedulerConfig,
  now: number,
  input: PlanInput,
): SchedulePlan {
  const { approved, declined = new Set<number>(), excludeIds = new Set<number>(), lastSwitch = new Map<number, string>() } = input;
  const priorities = streamers.filter(isLive).map((s) => priorityOf(s, history.get(s.id), cfg.weights, now));
  const score = new Map(priorities.map((p) => [p.streamerId, p.total]));
  const byId = new Map(streamers.map((s) => [s.id, s]));
  const retryWait = (s: SchedStreamer) => Boolean(s.record_retry_at && Date.parse(s.record_retry_at) > now);
  const gaveUp = (s: SchedStreamer) => (s.record_failures ?? 0) >= cfg.maxRetries;
  const eligible = (s: SchedStreamer) => isLive(s) && Boolean(s.auto_record) && approved.has(s.id) && !excludeIds.has(s.id) && !retryWait(s) && !gaveUp(s);
  const ranked = streamers
    .filter(eligible)
    .sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || Number(b.is_favorite) - Number(a.is_favorite) || (b.viewer_count ?? 0) - (a.viewer_count ?? 0));

  const decisions: SlotDecision[] = [];
  const taken = new Set<number>();
  const active = slots.slice(0, Math.max(0, cfg.maxSlots));
  // 1. keep healthy recordings (and paused slots' streamers while they are live)
  for (const sl of active) {
    const cur = sl.streamerId !== null ? byId.get(sl.streamerId) : undefined;
    if (cur && isLive(cur) && !taken.has(cur.id) && (eligible(cur) || (sl.paused && approved.has(cur.id)))) {
      taken.add(cur.id);
      decisions.push({ slot: sl.slot, streamerId: cur.id, action: "keep", detail: `Recording ${cur.display_name} (priority ${score.get(cur.id) ?? "?"}).` });
    } else {
      decisions.push({
        slot: sl.slot,
        streamerId: null,
        action: sl.streamerId !== null ? "release" : "idle",
        detail: cur
          ? isLive(cur)
            ? !cur.auto_record
              ? `${cur.display_name}: recording requests were turned off.`
              : declined.has(cur.id)
                ? `${cur.display_name}: recording stopped (declined for this broadcast).`
                : !approved.has(cur.id)
                  ? `${cur.display_name} started a new broadcast; it needs your approval.`
                  : `${cur.display_name} is no longer eligible (${retryWait(cur) ? "recording failed, retry later" : "recorded elsewhere"}).`
            : `${cur.display_name} went offline.`
          : "Free slot.",
      });
    }
  }
  // 2. fill free slots by priority
  for (const d of decisions) {
    if (d.streamerId !== null) continue;
    const next = ranked.find((s) => !taken.has(s.id));
    if (!next) continue;
    taken.add(next.id);
    d.streamerId = next.id;
    d.action = d.action === "release" ? "switch" : "assign";
    d.detail = `${next.display_name} gets this slot (priority ${score.get(next.id)}).`;
  }
  // 3. at most one switch: the best waiting streamer replaces the weakest recording, if clearly better
  const waiting = ranked.filter((s) => !taken.has(s.id));
  const challenger = waiting[0];
  if (challenger) {
    const candidates = decisions
      .map((d) => ({ d, sl: active.find((x) => x.slot === d.slot)! }))
      .filter(({ d, sl }) => d.action === "keep" && !sl.paused);
    const weakest = candidates.sort((a, b) => (score.get(a.d.streamerId!) ?? 0) - (score.get(b.d.streamerId!) ?? 0))[0];
    if (weakest) {
      const cur = byId.get(weakest.d.streamerId!)!;
      const gap = (score.get(challenger.id) ?? 0) - (score.get(cur.id) ?? 0);
      const recordedMin = weakest.sl.assignedAt ? (now - Date.parse(weakest.sl.assignedAt)) / 60_000 : Infinity;
      const last = lastSwitch.get(weakest.sl.slot);
      const sinceSwitch = last ? (now - Date.parse(last)) / 60_000 : Infinity;
      if (gap >= cfg.switchMargin && recordedMin >= cfg.minRecordMinutes && sinceSwitch >= cfg.cooldownMinutes && weakest.sl.pendingClips === 0) {
        taken.delete(cur.id);
        taken.add(challenger.id);
        weakest.d.streamerId = challenger.id;
        weakest.d.action = "switch";
        weakest.d.detail = `${challenger.display_name} (priority ${score.get(challenger.id)}) replaces ${cur.display_name} (${score.get(cur.id)}): ${gap} points higher.`;
      }
    }
  }

  // 4. everyone live but not recorded, with the reason
  const queue: QueueEntry[] = [];
  for (const s of streamers.filter(isLive)) {
    if (taken.has(s.id)) continue;
    const total = score.get(s.id) ?? null;
    let reason: QueueReason;
    let detail: string;
    if (excludeIds.has(s.id)) [reason, detail] = ["recorded_elsewhere", "Recorded in a manual capture."];
    else if (!s.auto_record) [reason, detail] = ["auto_record_off", "Recording requests are off for this streamer."];
    else if (declined.has(s.id)) [reason, detail] = ["declined", "You declined recording this broadcast."];
    else if (!approved.has(s.id)) [reason, detail] = ["awaiting_approval", "Waiting for your approval to record this broadcast."];
    else if (gaveUp(s)) [reason, detail] = ["gave_up", `Recording failed ${s.record_failures} times (${s.record_error ?? "unknown error"}); not retried until the next broadcast.`];
    else if (retryWait(s)) [reason, detail] = ["retry_wait", `Recording failed (${s.record_error ?? "unknown error"}); retrying ${new Date(s.record_retry_at!).toLocaleTimeString()}.`];
    else {
      reason = "waiting_for_slot";
      const position = ranked.filter((x) => !taken.has(x.id)).findIndex((x) => x.id === s.id) + 1;
      const lowest = Math.min(...decisions.filter((d) => d.streamerId !== null).map((d) => score.get(d.streamerId!) ?? 0));
      detail =
        active.length === 0
          ? "No recorder tab is armed."
          : decisions.every((d) => d.streamerId !== null)
            ? `Approved, #${position} in the queue: all ${active.length} slot${active.length === 1 ? "" : "s"} busy${Number.isFinite(lowest) && total !== null && total - lowest >= cfg.switchMargin ? "; will replace the weakest recording when its minimum time and cooldown allow" : ""}.`
            : `Approved, #${position} in the queue.`;
    }
    queue.push({ streamerId: s.id, name: s.display_name, total, reason, detail });
  }
  const order: QueueReason[] = ["waiting_for_slot", "awaiting_approval", "retry_wait", "gave_up", "declined", "recorded_elsewhere", "auto_record_off"];
  queue.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason) || (b.total ?? 0) - (a.total ?? 0));
  return { priorities: priorities.sort((a, b) => b.total - a.total), decisions, queue };
}

/** After a failed recording: when to try this streamer again (null = gave up for this broadcast). */
export function nextRetry(failures: number, now: number, maxRetries: number): string | null {
  if (failures >= maxRetries) return null;
  const min = RETRY_MINUTES[Math.min(failures - 1, RETRY_MINUTES.length - 1)] ?? 15;
  return new Date(now + min * 60_000).toISOString();
}
