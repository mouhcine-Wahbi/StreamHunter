/**
 * Offscreen document: hosts the capture engines (Chrome only allows tab capture with media APIs in a
 * document, not in the service worker, and an extension has one offscreen document). One engine per
 * recording slot (= captured tab), each with its own buffer, detection and clips; several run at
 * once. The worker addresses them by slot. Video and audio never leave the browser.
 */
import { startEngine, type CaptureEngine } from "@/capture/engine";
import type { OffscreenRequest, RuntimeRequest } from "@/types/messages";
import { isBusy, runQueue } from "@/processing/runner";

const engines = new Map<number, CaptureEngine>();
(globalThis as { __streamhunterEngines?: typeof engines }).__streamhunterEngines = engines;

function send(message: RuntimeRequest): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as OffscreenRequest | null;
  if (m?.target !== "offscreen") return false; // meant for the worker
  const engine = "slot" in m && typeof m.slot === "number" ? engines.get(m.slot) : undefined;
  const reply = (p: Promise<unknown> | undefined) => {
    void (p ?? Promise.resolve()).then(() => sendResponse({ ok: Boolean(engine) }));
    return true;
  };
  switch (m.type) {
    // 3.0 processing queue (clips → vertical/landscape assets, analyses of authorized files).
    case "process/kick":
      void runQueue(send);
      sendResponse({ ok: true });
      return false;
    case "process/busy":
      sendResponse({ ok: true, busy: isBusy() });
      return false;
    case "capture/start": {
      if (typeof m.streamId !== "string" || !m.options || typeof m.slot !== "number") return false;
      const slot = m.slot;
      void (async () => {
        await engines.get(slot)?.stop("Replaced by a new capture");
        const e = await startEngine(m.streamId, m.capture ?? null, m.options, {
          status: (s) => send({ type: "capture/status", slot, ...s }),
          clipSaved: (c) => send({ type: "capture/clip-saved", slot, ...c }),
          clipFailed: (c) => send({ type: "capture/clip-failed", slot, ...c }),
          detection: (d) => send({ type: "capture/detection", slot, ...d }),
          ended: (reason) => {
            if (engines.get(slot) === e) engines.delete(slot);
            send({ type: "capture/ended", slot, reason });
          },
        });
        engines.set(slot, e);
      })().then(
        () => sendResponse({ ok: true }),
        (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : "Could not start the capture" }),
      );
      return true;
    }
    case "capture/clip":
      if (engine && m.request) engine.requestClip(m.request);
      sendResponse({ ok: Boolean(engine) });
      return false;
    case "capture/signal":
      if (engine && m.signal) engine.signal(m.signal);
      sendResponse({ ok: Boolean(engine) });
      return false;
    case "capture/target":
      return reply(engine?.setTarget(m.capture ?? null));
    case "capture/pause":
      return reply(engine?.setPaused(Boolean(m.paused)));
    case "capture/listen":
      engine?.setListening(Boolean(m.on));
      sendResponse({ ok: Boolean(engine) });
      return false;
    case "capture/throttle":
      engine?.setThrottled(Boolean(m.on));
      sendResponse({ ok: Boolean(engine) });
      return false;
    case "capture/options":
      if (engine && m.options) engine.updateOptions(m.options);
      sendResponse({ ok: Boolean(engine) });
      return false;
    case "capture/stop": {
      const targets = typeof m.slot === "number" ? [engines.get(m.slot)] : [...engines.values()];
      void Promise.all(targets.map((e) => e?.stop("Stopped"))).then(() => sendResponse({ ok: true }));
      return true;
    }
  }
  return false;
});
