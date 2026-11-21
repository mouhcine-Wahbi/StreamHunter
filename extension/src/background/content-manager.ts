/**
 * Worker side of 3.0 metadata and scoring. Chrome's on-device model is used from the worker when
 * the worker has it, otherwise from the offscreen document; neither is required.
 */
import { localPromptApi, type OnDevicePort, type OnDeviceState } from "@/metadata/generate";
import { prepareContent } from "@/local/content";
import type { Settings } from "@/types/settings";

export interface ContentDeps {
  ensureOffscreen: () => Promise<void>;
  toOffscreen: (m: unknown) => Promise<unknown>;
}

export function offscreenPromptPort(deps: ContentDeps): OnDevicePort {
  return {
    async availability() {
      await deps.ensureOffscreen();
      const r = (await deps.toOffscreen({ target: "offscreen", type: "ai/availability" }).catch(() => null)) as { state?: OnDeviceState } | null;
      return r?.state ?? "absent";
    },
    async prompt(system, user, schema) {
      await deps.ensureOffscreen();
      const r = (await deps.toOffscreen({ target: "offscreen", type: "ai/prompt", system, user, schema })) as { ok: boolean; text?: string; error?: string } | null;
      if (!r?.ok || !r.text) throw new Error(r?.error ?? "no answer");
      return r.text;
    },
  };
}

export function createContentManager(deps: ContentDeps) {
  let port: { p: OnDevicePort; where: "worker" | "offscreen" } | null = null;
  async function onDevice(): Promise<{ p: OnDevicePort; where: "worker" | "offscreen" } | null> {
    if (port) return port;
    const local = localPromptApi();
    if (local) return (port = { p: local, where: "worker" });
    const off = offscreenPromptPort(deps);
    return (await off.availability()) === "absent" ? null : (port = { p: off, where: "offscreen" });
  }
  return {
    async status(): Promise<{ onDevice: OnDeviceState; where: "worker" | "offscreen" | null }> {
      const o = await onDevice().catch(() => null);
      return { onDevice: o ? await o.p.availability() : "absent", where: o?.where ?? null };
    },
    async prepare(clipId: number, settings: Settings, opts: { regenerate?: boolean; resetEdits?: boolean } = {}) {
      const o = settings.ai.onDevice ? await onDevice().catch(() => null) : null;
      const clip = await prepareContent(clipId, settings, { onDevice: o?.p ?? null }, opts);
      return clip;
    },
  };
}

export type ContentManager = ReturnType<typeof createContentManager>;
