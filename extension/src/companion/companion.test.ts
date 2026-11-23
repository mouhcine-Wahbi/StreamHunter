import { createCompanionManager, explainDisconnect, getFile, putFile, type CompanionStatus } from "./client";

type Listener<T> = (m: T) => void;

/** A fake chrome.runtime.Port speaking the companion protocol. */
function fakeHost(reply: (msg: { id: number; type: string }) => unknown | undefined) {
  const sent: { id: number; type: string }[] = [];
  let lastError: string | undefined;
  const ports: { disconnect: () => void; drop: (err: string) => void }[] = [];
  const connectNative = vi.fn(() => {
    const onMessage: Listener<unknown>[] = [];
    const onDisconnect: Listener<void>[] = [];
    let open = true;
    const port = {
      name: "",
      onMessage: { addListener: (f: Listener<unknown>) => onMessage.push(f) },
      onDisconnect: { addListener: (f: Listener<void>) => onDisconnect.push(f) },
      postMessage: (m: { id: number; type: string }) => {
        if (!open) throw new Error("Attempting to use a disconnected port object");
        sent.push(m);
        const r = reply(m);
        if (r !== undefined) queueMicrotask(() => onMessage.forEach((f) => f(r)));
      },
      disconnect: () => {
        open = false;
      },
    };
    ports.push({
      disconnect: port.disconnect,
      drop: (err) => {
        open = false;
        lastError = err;
        onDisconnect.forEach((f) => f());
      },
    });
    return port as unknown as chrome.runtime.Port;
  });
  return { sent, connectNative, ports, lastError: () => lastError };
}

const hello = { version: "0.1.0", protocol: 1, node: "v22.23.5", port: 50123, token: "t".repeat(64), work_dir: "/w", free_bytes: 10, used_bytes: 1, tools: { ffmpeg: { name: "ffmpeg", ok: true } } };

function manager(host: ReturnType<typeof fakeHost>, opts: { permission?: boolean; idleMs?: number; timeoutMs?: number } = {}) {
  const saved: CompanionStatus[] = [];
  const m = createCompanionManager({
    hasPermission: async () => opts.permission ?? true,
    connectNative: host.connectNative,
    lastError: host.lastError,
    save: async (s) => void saved.push(s),
    idleMs: opts.idleMs,
    timeoutMs: opts.timeoutMs,
    now: () => new Date("2026-11-23T10:00:00Z"),
  });
  return { m, saved };
}

describe("companion client (4.0)", () => {
  it("connects, says hello and records the tools; the file channel address stays in memory, not in storage", async () => {
    const host = fakeHost((msg) => (msg.type === "hello" ? { id: msg.id, ok: true, data: hello } : undefined));
    const { m, saved } = manager(host);
    const s = await m.check();
    expect(s).toMatchObject({ state: "connected", version: "0.1.0", work_dir: "/w", tools: { ffmpeg: { ok: true } } });
    expect(JSON.stringify(saved)).not.toContain("t".repeat(64));
    expect(await m.endpoint()).toEqual({ base: "http://127.0.0.1:50123", token: "t".repeat(64) });
    expect(host.connectNative).toHaveBeenCalledTimes(1);
    expect(host.connectNative).toHaveBeenCalledWith("com.streamhunter.companion");
    m.close();
  });

  it("without the permission it never calls connectNative", async () => {
    const host = fakeHost(() => undefined);
    const { m } = manager(host, { permission: false });
    expect((await m.check()).state).toBe("no_permission");
    expect(host.connectNative).not.toHaveBeenCalled();
    await expect(m.endpoint()).rejects.toThrow(/permission/);
  });

  it("explains Chrome's errors: not installed, wrong extension ID, crashed", async () => {
    for (const [err, state] of [
      ["Specified native messaging host not found.", "not_installed"],
      ["Access to the specified native messaging host is forbidden.", "forbidden"],
      ["Native host has exited.", "error"],
    ] as const) {
      const host = fakeHost(() => undefined);
      const { m } = manager(host);
      const p = m.check();
      await Promise.resolve();
      host.ports[0]!.drop(err);
      const s = await p;
      expect(s.state).toBe(state);
      expect(s.message).toBe(explainDisconnect(err).message);
    }
  });

  it("refuses a companion speaking another protocol, and times out a silent one", async () => {
    const v2 = fakeHost((msg) => ({ id: msg.id, ok: true, data: { ...hello, protocol: 2 } }));
    expect((await manager(v2).m.check()).message).toMatch(/protocol 2/);
    const silent = fakeHost(() => undefined);
    expect((await manager(silent, { timeoutMs: 20 }).m.check()).message).toMatch(/didn't answer/);
  });

  it("disconnects when idle so the companion process exits, and reconnects on the next request", async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost((msg) => ({ id: msg.id, ok: true, data: msg.type === "hello" ? hello : { free_bytes: 1 } }));
      const { m } = manager(host, { idleMs: 1000 });
      await m.check();
      expect(m.connected).toBe(true);
      await vi.advanceTimersByTimeAsync(1001);
      expect(m.connected).toBe(false);
      await m.endpoint();
      expect(host.connectNative).toHaveBeenCalledTimes(2);
      m.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("file channel helpers send the token and report the companion's errors", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (init?.method === "PUT") return new Response(JSON.stringify({ name: "a.mp4", size: 3, sha256: "x" }));
      return new Response(JSON.stringify({ error: "No such file" }), { status: 404 });
    }) as typeof fetch;
    const ep = { base: "http://127.0.0.1:1", token: "tok" };
    expect(await putFile(ep, "a.mp4", new Blob(["abc"]), f)).toEqual({ name: "a.mp4", size: 3, sha256: "x" });
    expect(calls[0]![0]).toBe("http://127.0.0.1:1/v1/files/a.mp4");
    expect(calls[0]![1]!.headers).toEqual({ "x-sh-token": "tok" });
    await expect(getFile(ep, "b.mp4", f)).rejects.toThrow("No such file");
  });
});
