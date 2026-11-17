/**
 * Offscreen document: hosts the capture engine (Chrome only allows tab capture with media APIs in a
 * document, not in the service worker). The worker starts/stops it and forwards clip requests;
 * the engine reports status and saved clips back. Video and audio never leave the browser.
 */
import { startEngine, type CaptureEngine } from "@/capture/engine";
import type { OffscreenRequest, RuntimeRequest } from "@/types/messages";

let engine: CaptureEngine | null = null;

function send(message: RuntimeRequest) {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as Partial<OffscreenRequest> | null;
  if (m?.target !== "offscreen") return false; // meant for the worker
  if (m.type === "capture/start" && typeof m.streamId === "string" && m.capture && m.options) {
    const { capture, options, streamId } = m;
    void (async () => {
      await engine?.stop("Replaced by a new capture");
      engine = await startEngine(streamId, capture, options, {
        status: (s) => send({ type: "capture/status", ...s }),
        clipSaved: (c) => send({ type: "capture/clip-saved", ...c }),
        clipFailed: (c) => send({ type: "capture/clip-failed", ...c }),
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
  if (m.type === "capture/clip" && m.request) {
    if (engine) engine.requestClip(m.request);
    sendResponse({ ok: Boolean(engine) });
    return false;
  }
  if (m.type === "capture/stop") {
    void (engine?.stop("Stopped") ?? Promise.resolve()).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
