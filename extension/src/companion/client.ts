/**
 * StreamHunter 4.0: the optional local companion (native messaging host "com.streamhunter.companion").
 * It runs FFmpeg, Whisper, yt-dlp and Remotion on this computer; the extension stays fully usable
 * without it. Control messages go over native messaging; video files go over the companion's
 * 127.0.0.1 file channel with a per-launch token, which stays in the service worker's memory and
 * is handed only to this extension's own pages.
 */
export const COMPANION_HOST = "com.streamhunter.companion";
export const COMPANION_KEY = "sh.companion";
export const COMPANION_PROTOCOL = 1;

export type CompanionState = "no_permission" | "not_installed" | "forbidden" | "connected" | "error";

export interface CompanionTool {
  name: string;
  found: boolean;
  path: string | null;
  version: string | null;
  ok: boolean;
  detail: string | null;
  min: string;
  why: string;
  videotoolbox?: boolean;
  libx264?: boolean;
  loudnorm?: boolean;
}

export interface CompanionStatus {
  state: CompanionState;
  message: string | null;
  version: string | null;
  protocol: number | null;
  node: string | null;
  work_dir: string | null;
  free_bytes: number | null;
  used_bytes: number | null;
  tools: Record<string, CompanionTool> | null;
  checked_at: string;
}

export interface CompanionEndpoint {
  base: string;
  token: string;
}

interface Hello {
  version: string;
  protocol: number;
  node: string;
  port: number;
  token: string;
  work_dir: string;
  free_bytes: number;
  used_bytes: number;
  tools: Record<string, CompanionTool>;
}

/** Chrome's messages when connectNative fails, in plain words. */
export function explainDisconnect(message: string | undefined): { state: CompanionState; message: string } {
  const m = message ?? "";
  if (/not found/i.test(m)) return { state: "not_installed", message: "The companion isn't installed for this Chrome profile. Run the installer shown below." };
  if (/forbidden/i.test(m)) return { state: "forbidden", message: "The companion is installed for a different extension ID. Run the installer again with the ID shown below." };
  if (/exited/i.test(m)) return { state: "error", message: "The companion started but stopped. Check its log in the work folder (logs/companion.log)." };
  return { state: "error", message: m || "The companion couldn't be reached." };
}

/** An event the companion sends without being asked (4.2: edit job progress). */
export interface CompanionJob {
  id: string;
  state: "queued" | "probing" | "encoding" | "validating" | "done" | "failed" | "cancelled";
  step: string;
  progress: number;
  error: string | null;
  attempts: number;
  output: { video: string; thumbnail: string | null; width: number; height: number; duration: number; size: number; has_audio: boolean } | null;
  metrics: { wall_ms: number; cpu_ms: number; peak_rss_bytes: number; encoder: string } | null;
  notes: string[];
  template: string;
}
export type CompanionEvent = { event: "job"; job: CompanionJob };

export interface CompanionDeps {
  hasPermission: () => Promise<boolean>;
  connectNative: (host: string) => chrome.runtime.Port;
  lastError: () => string | undefined;
  save: (s: CompanionStatus) => Promise<void>;
  now?: () => Date;
  /** Disconnect after this long without requests, so the companion process exits. */
  idleMs?: number;
  timeoutMs?: number;
}

export function createCompanionManager(deps: CompanionDeps) {
  const now = deps.now ?? (() => new Date());
  const idleMs = deps.idleMs ?? 5 * 60_000;
  const timeoutMs = deps.timeoutMs ?? 90_000;
  let port: chrome.runtime.Port | null = null;
  let hello: Hello | null = null;
  let nextId = 1;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let disconnectReason: string | undefined;
  const listeners = new Set<(event: CompanionEvent) => void>();
  let holds = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const empty = (state: CompanionState, message: string | null): CompanionStatus => ({
    state, message, version: null, protocol: null, node: null, work_dir: null, free_bytes: null, used_bytes: null, tools: null, checked_at: now().toISOString(),
  });

  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = holds > 0 ? null : setTimeout(() => close(), idleMs);
  };

  function close() {
    if (idle) clearTimeout(idle);
    idle = null;
    port?.disconnect();
    dropped(undefined);
  }

  function dropped(reason: string | undefined) {
    port = null;
    hello = null;
    disconnectReason = reason;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(explainDisconnect(reason).message));
    }
    pending.clear();
  }

  function open(): chrome.runtime.Port {
    if (port) return port;
    const p = deps.connectNative(COMPANION_HOST);
    p.onMessage.addListener((msg: { id?: number; ok: boolean; data?: unknown; error?: string; event?: string }) => {
      // Messages without an id are events the companion sends on its own (job progress).
      if (msg.id === undefined && typeof msg.event === "string") {
        for (const l of listeners) l(msg as unknown as CompanionEvent);
        return;
      }
      const waiting = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!waiting) return;
      pending.delete(msg.id!);
      clearTimeout(waiting.timer);
      if (msg.ok) waiting.resolve(msg.data);
      else waiting.reject(new Error(msg.error ?? "The companion refused the request."));
    });
    p.onDisconnect.addListener(() => dropped(deps.lastError() ?? "Native host has exited."));
    port = p;
    return p;
  }

  async function request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const p = open();
    touch();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The companion didn't answer in time."));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        p.postMessage({ id, type, ...payload });
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Connects (if allowed), says hello and records the result. Never throws. */
  async function check(): Promise<CompanionStatus> {
    let status: CompanionStatus;
    if (!(await deps.hasPermission())) {
      status = empty("no_permission", "StreamHunter needs your permission to talk to the companion.");
    } else {
      try {
        if (port) close(); // a fresh hello, fresh tool versions
        const h = await request<Hello>("hello");
        if (h.protocol !== COMPANION_PROTOCOL) throw new Error(`This companion speaks protocol ${h.protocol}; StreamHunter needs ${COMPANION_PROTOCOL}. Update the companion.`);
        hello = h;
        status = { state: "connected", message: null, version: h.version, protocol: h.protocol, node: h.node, work_dir: h.work_dir, free_bytes: h.free_bytes, used_bytes: h.used_bytes, tools: h.tools, checked_at: now().toISOString() };
      } catch (e) {
        const why = disconnectReason !== undefined ? explainDisconnect(disconnectReason) : { state: "error" as const, message: e instanceof Error ? e.message : String(e) };
        status = empty(why.state, why.message);
      }
    }
    await deps.save(status);
    return status;
  }

  async function endpoint(): Promise<CompanionEndpoint> {
    if (!hello || !port) {
      const s = await check();
      if (s.state !== "connected") throw new Error(s.message ?? "The companion isn't connected.");
    }
    touch();
    return { base: `http://127.0.0.1:${hello!.port}`, token: hello!.token };
  }

  return {
    check,
    endpoint,
    request,
    close,
    get connected() {
      return port !== null && hello !== null;
    },
    /** Listen to companion events; returns an unsubscribe function. */
    onEvent(l: (event: CompanionEvent) => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    /** Keep the connection (and so the companion and its running edit) open while work is pending. */
    hold(on: boolean) {
      holds = Math.max(0, holds + (on ? 1 : -1));
      if (port) touch();
    },
  };
}

export type CompanionManager = ReturnType<typeof createCompanionManager>;

/** Upload a file to the companion's work folder over its file channel (extension pages and worker). */
export async function putFile(ep: CompanionEndpoint, name: string, body: Blob, fetchImpl: typeof fetch = fetch): Promise<{ name: string; size: number; sha256: string }> {
  const r = await fetchImpl(`${ep.base}/v1/files/${encodeURIComponent(name)}`, { method: "PUT", headers: { "x-sh-token": ep.token }, body });
  const j = (await r.json().catch(() => ({}))) as { error?: string; name: string; size: number; sha256: string };
  if (!r.ok) throw new Error(j.error ?? `Upload failed (${r.status})`);
  return j;
}

export async function getFile(ep: CompanionEndpoint, name: string, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  const r = await fetchImpl(`${ep.base}/v1/files/${encodeURIComponent(name)}`, { headers: { "x-sh-token": ep.token } });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Download failed (${r.status})`);
  return r.blob();
}
