/**
 * Offscreen document: hosts the capture engine (Chrome only allows tab capture with media APIs in a
 * document, not in the service worker). The worker starts/stops it, switches its target streamer,
 * forwards chat/viewer signals and clip requests; the engine reports status, detections and saved
 * clips back. Video and audio never leave the browser.
 */
import { startEngine, type CaptureEngine } from "@/capture/engine";
import type { OffscreenRequest, RuntimeRequest } from "@/types/messages";

let engine: CaptureEngine | null = null;

function send(message: RuntimeRequest) {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as OffscreenRequest | null;
  if (m?.target !== "offscreen") return false; // meant for the worker
  switch (m.type) {
    case "capture/start": {
      if (typeof m.streamId !== "string" || !m.options) return false;
      void (async () => {
        await engine?.stop("Replaced by a new capture");
        engine = await startEngine(m.streamId, m.capture ?? null, m.options, {
          status: (s) => send({ type: "capture/status", ...s }),
          clipSaved: (c) => send({ type: "capture/clip-saved", ...c }),
          clipFailed: (c) => send({ type: "capture/clip-failed", ...c }),
          detection: (d) => send({ type: "capture/detection", ...d }),
          ended: (reason) => {
            engine = null;
            send({ type: "capture/ended", reason });
          },
        });
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
      void (engine?.setTarget(m.capture ?? null) ?? Promise.resolve()).then(() => sendResponse({ ok: Boolean(engine) }));
      return true;
    case "capture/pause":
      void (engine?.setPaused(Boolean(m.paused)) ?? Promise.resolve()).then(() => sendResponse({ ok: Boolean(engine) }));
      return true;
    case "capture/options":
      if (engine && m.options) engine.updateOptions(m.options);
      sendResponse({ ok: Boolean(engine) });
      return false;
    case "capture/stop":
      void (engine?.stop("Stopped") ?? Promise.resolve()).then(() => sendResponse({ ok: true }));
      return true;
  }
  return false;
});
