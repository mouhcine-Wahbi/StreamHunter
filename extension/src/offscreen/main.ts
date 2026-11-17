/**
 * Offscreen document: measures the loudness of a captured tab.
 *
 * The worker passes a tab-capture stream id; this page opens the stream, routes it back to the
 * speakers (capturing would otherwise mute the tab), and sends one loudness value per second to
 * the worker in batches of ~5 s. With sound detection on (opt-in), each batch also carries the
 * tab's audio as 16 kHz mono samples, which the worker passes to the editor's own backend for
 * laughter/cheering detection. Audio is never recorded or stored.
 */
import type { OffscreenRequest, RuntimeRequest } from "@/types/messages";
import type { LoudnessSample } from "@/types/tab-audio";
import { LoudnessMeter } from "./loudness";
import { Downsampler, PcmBatcher } from "./pcm";

const READ_EVERY_MS = 50;
const SAMPLE_EVERY_MS = 1000;
const SEND_EVERY_MS = 5000;

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  timers: number[];
  pending: LoudnessSample[];
  pcm: PcmBatcher | null;
}

let session: Session | null = null;

function send(message: RuntimeRequest) {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function startPcm(ctx: AudioContext, source: MediaStreamAudioSourceNode): Promise<PcmBatcher> {
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  const tap = new AudioWorkletNode(ctx, "pcm-tap");
  const mute = ctx.createGain();
  mute.gain.value = 0; // the worklet has to be connected to run; the tab is already audible via `source`
  source.connect(tap).connect(mute).connect(ctx.destination);
  const down = new Downsampler(ctx.sampleRate);
  const batcher = new PcmBatcher();
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => batcher.add(down.push(e.data), Date.now());
  return batcher;
}

async function start(streamId: string, sounds: boolean) {
  stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } as unknown as MediaTrackConstraints,
    video: false,
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination); // keep the tab audible
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  const meter = new LoudnessMeter();
  const s: Session = { stream, ctx, timers: [], pending: [], pcm: null };
  if (sounds) {
    try {
      s.pcm = await startPcm(ctx, source);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      throw new Error(`Sound detection could not start: ${e instanceof Error ? e.message : "audio worklet failed"}`);
    }
  }
  s.timers.push(
    window.setInterval(() => {
      analyser.getFloatTimeDomainData(frame);
      meter.add(frame);
    }, READ_EVERY_MS),
    window.setInterval(() => {
      const sample = meter.take(new Date());
      if (sample) s.pending.push(sample);
    }, SAMPLE_EVERY_MS),
    window.setInterval(() => {
      const pcm = s.pcm?.take() ?? undefined;
      if (s.pending.length === 0 && !pcm) return;
      send({ type: "tab-audio/samples", samples: s.pending.splice(0), ...(pcm ? { pcm } : {}) });
    }, SEND_EVERY_MS),
  );
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      stop();
      send({ type: "tab-audio/ended", reason: "The tab was closed or stopped sharing audio" });
    });
  }
  session = s;
}

function stop() {
  if (!session) return;
  session.timers.forEach((t) => clearInterval(t));
  session.stream.getTracks().forEach((t) => t.stop());
  void session.ctx.close();
  session = null;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const m = message as Partial<OffscreenRequest> | null;
  if (m?.target !== "offscreen") return false; // meant for the worker
  if (m.type === "meter/start" && typeof m.streamId === "string") {
    start(m.streamId, m.sounds === true).then(
      () => sendResponse({ ok: true }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : "Could not open the tab's audio" }),
    );
    return true;
  }
  if (m.type === "meter/stop") {
    stop();
    sendResponse({ ok: true });
  }
  return false;
});
