/**
 * Overload protection for simultaneous recording. Every ~10 s (driven by engine reports) it measures
 * whole-machine CPU (chrome.system.cpu), free memory (chrome.system.memory), browser storage
 * (navigator.storage) and each slot's encoder health, then:
 *
 *   overloaded → refuse new slots; lower the lowest-priority stream to half frame rate; if that is
 *                not enough, pause it (reason "overload") and notify;
 *   healthy for a minute → undo the last step (resume, then full frame rate);
 *   storage nearly full → clean up old clips; if still full, pause every stream (reason "storage").
 *
 * `decide` is pure; `createGovernor` wires it to Chrome.
 */
import type { CaptureState, SystemLoad } from "@/types/capture";

export const LIMITS = {
  cpuPercent: 90, // sustained whole-machine CPU
  minFreeMemBytes: 1.5 * 1024 ** 3,
  minFps: 20, // a 30 fps recording below this is falling behind
  minFreeStorageBytes: 2 * 1024 ** 3,
  overloadedSamples: 3, // ~30 s before acting
  healthySamples: 6, // ~60 s before undoing
} as const;

export interface Sample {
  cpuPercent: number | null;
  memAvailableBytes: number | null;
  storageFreeBytes: number | null;
}

export interface GovernorMemory {
  overloadedRuns: number;
  healthyRuns: number;
}

export type Action =
  | { kind: "throttle"; tabId: number; on: boolean }
  | { kind: "pause"; tabId: number; paused: boolean; reason: "overload" | "storage" }
  | { kind: "cleanup" };

export interface Decision {
  overloaded: boolean;
  reason: string | null;
  actions: Action[];
  memory: GovernorMemory;
  /** Human summary of what was done. */
  note: string | null;
}

/** Why this sample counts as overloaded (null = healthy). */
export function overloadReason(s: Sample, slots: CaptureState[]): string | null {
  if (s.cpuPercent !== null && s.cpuPercent >= LIMITS.cpuPercent) return `CPU at ${Math.round(s.cpuPercent)}%`;
  if (s.memAvailableBytes !== null && s.memAvailableBytes < LIMITS.minFreeMemBytes)
    return `only ${(s.memAvailableBytes / 1024 ** 3).toFixed(1)} GB of memory free`;
  const slow = slots.find((x) => x.recording && x.health && !x.health.throttled && x.health.fps > 0 && x.health.fps < LIMITS.minFps);
  if (slow) return `${slow.channel ?? "a stream"} is encoding at ${slow.health!.fps} fps`;
  return null;
}

/**
 * @param slots recording slots, highest priority first (the last one is sacrificed first).
 */
export function decide(s: Sample, slots: CaptureState[], mem: GovernorMemory): Decision {
  const actions: Action[] = [];
  const name = (x: CaptureState) => x.channel ?? `tab ${x.tabId}`;

  // Storage first: it can't recover by waiting.
  if (s.storageFreeBytes !== null && s.storageFreeBytes < LIMITS.minFreeStorageBytes) {
    actions.push({ kind: "cleanup" });
    const live = slots.filter((x) => x.tabId !== null && !x.paused);
    for (const x of live) actions.push({ kind: "pause", tabId: x.tabId!, paused: true, reason: "storage" });
    return {
      overloaded: true, reason: "the disk is almost full", actions, memory: { overloadedRuns: 0, healthyRuns: 0 },
      note: live.length ? "Paused recording: the disk is almost full. Delete clips or free disk space." : null,
    };
  }
  const storagePaused = slots.filter((x) => x.paused && x.pauseReason === "storage" && x.tabId !== null);
  for (const x of storagePaused) actions.push({ kind: "pause", tabId: x.tabId!, paused: false, reason: "storage" });

  const reason = overloadReason(s, slots);
  if (reason) {
    const runs = mem.overloadedRuns + 1;
    const memory = { overloadedRuns: runs, healthyRuns: 0 };
    if (runs < LIMITS.overloadedSamples) return { overloaded: true, reason, actions, memory, note: null };
    const active = slots.filter((x) => x.recording && x.tabId !== null);
    const lowest = [...active].reverse();
    const toThrottle = lowest.find((x) => !x.health?.throttled);
    // Keep the highest-priority stream recording at all costs.
    const toPause = active.length > 1 ? lowest.find((x) => x.health?.throttled) : undefined;
    let note: string | null = null;
    if (toThrottle) {
      actions.push({ kind: "throttle", tabId: toThrottle.tabId!, on: true });
      note = `${reason}: recording ${name(toThrottle)} at half frame rate.`;
    } else if (toPause) {
      actions.push({ kind: "pause", tabId: toPause.tabId!, paused: true, reason: "overload" });
      note = `${reason}: paused ${name(toPause)} to protect the other streams.`;
    }
    return { overloaded: true, reason, actions, memory: { ...memory, overloadedRuns: note ? 0 : runs }, note };
  }

  const healthy = mem.healthyRuns + 1;
  if (healthy < LIMITS.healthySamples) return { overloaded: false, reason: null, actions, memory: { overloadedRuns: 0, healthyRuns: healthy }, note: null };
  // Undo one step: resume a stream paused for overload, else restore a throttled one.
  const paused = slots.find((x) => x.paused && x.pauseReason === "overload" && x.tabId !== null);
  const throttled = slots.find((x) => x.health?.throttled && x.tabId !== null);
  let note: string | null = null;
  if (paused) {
    actions.push({ kind: "pause", tabId: paused.tabId!, paused: false, reason: "overload" });
    note = `Load is back to normal: resumed ${name(paused)}.`;
  } else if (throttled) {
    actions.push({ kind: "throttle", tabId: throttled.tabId!, on: false });
    note = `Load is back to normal: ${name(throttled)} records at full frame rate again.`;
  }
  return { overloaded: false, reason: null, actions, memory: { overloadedRuns: 0, healthyRuns: note ? 0 : healthy }, note };
}

/** Whole-machine CPU use between two chrome.system.cpu readings, 0–100. */
export function cpuPercent(
  prev: { usage: { user: number; kernel: number; idle: number; total: number } }[],
  next: { usage: { user: number; kernel: number; idle: number; total: number } }[],
): number | null {
  let busy = 0;
  let total = 0;
  next.forEach((p, i) => {
    const q = prev[i];
    if (!q) return;
    total += p.usage.total - q.usage.total;
    busy += p.usage.total - q.usage.total - (p.usage.idle - q.usage.idle);
  });
  return total > 0 ? Math.round((busy / total) * 1000) / 10 : null;
}

export interface GovernorDeps {
  now: () => number;
  readCpu: () => Promise<{ usage: { user: number; kernel: number; idle: number; total: number } }[] | null>;
  readMemory: () => Promise<{ availableCapacity: number; capacity: number } | null>;
  readStorage: () => Promise<{ usage: number; quota: number } | null>;
  slots: () => Promise<CaptureState[]>;
  enabled: () => Promise<boolean>;
  apply: (a: Action) => Promise<void>;
  notify: (message: string) => Promise<void>;
  save: (load: SystemLoad) => Promise<void>;
}

const INTERVAL_MS = 10_000;

export function createGovernor(deps: GovernorDeps) {
  let mem: GovernorMemory = { overloadedRuns: 0, healthyRuns: 0 };
  let prevCpu: Awaited<ReturnType<GovernorDeps["readCpu"]>> = null;
  let last = 0;
  let lastAction: string | null = null;
  let running: Promise<void> | null = null;

  async function run(): Promise<void> {
    const [cpu, memory, storage, slots, enabled] = await Promise.all([
      deps.readCpu().catch(() => null), deps.readMemory().catch(() => null), deps.readStorage().catch(() => null), deps.slots(), deps.enabled(),
    ]);
    const cpuPct = prevCpu && cpu ? cpuPercent(prevCpu, cpu) : null;
    prevCpu = cpu;
    const sample: Sample = {
      cpuPercent: cpuPct,
      memAvailableBytes: memory?.availableCapacity ?? null,
      storageFreeBytes: storage ? Math.max(0, storage.quota - storage.usage) : null,
    };
    const d = enabled ? decide(sample, slots, mem) : { overloaded: false, reason: null, actions: [] as Action[], memory: mem, note: null };
    mem = d.memory;
    for (const a of d.actions) await deps.apply(a).catch(() => undefined);
    if (d.note) {
      lastAction = d.note;
      await deps.notify(d.note).catch(() => undefined);
    }
    await deps.save({
      at: new Date(deps.now()).toISOString(), cpuPercent: cpuPct, memAvailableBytes: memory?.availableCapacity ?? null,
      memCapacityBytes: memory?.capacity ?? null, storageUsedBytes: storage?.usage ?? null, storageQuotaBytes: storage?.quota ?? null,
      overloaded: d.overloaded, reason: d.reason, lastAction,
    });
  }

  return {
    /** Called on every engine report; measures at most every 10 s. */
    async maybeRun(force = false): Promise<void> {
      if (running) return running;
      if (!force && deps.now() - last < INTERVAL_MS) return;
      last = deps.now();
      running = run().finally(() => (running = null));
      return running;
    },
  };
}

export const defaultGovernorIo = {
  readCpu: async () => ((await chrome.system?.cpu?.getInfo())?.processors ?? null) as { usage: { user: number; kernel: number; idle: number; total: number } }[] | null,
  readMemory: async () => (chrome.system?.memory ? await chrome.system.memory.getInfo() : null),
  readStorage: async () => {
    const e = await navigator.storage?.estimate?.();
    return e?.quota !== undefined ? { usage: e.usage ?? 0, quota: e.quota } : null;
  },
};
