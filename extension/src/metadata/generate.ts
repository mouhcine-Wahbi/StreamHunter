/**
 * Metadata generation with a fixed fallback order (3.0 phase 6):
 *   1. On-device AI (Chrome's built-in model) when it's actually available on this computer.
 *   2. Your external provider, if you configured one (Claude with your own Anthropic key, or an
 *      OpenAI-compatible endpoint such as a local model server).
 *   3. Local templates (always work).
 * No option is required; every failure falls through to the next with the reason recorded.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Destination } from "@/local/rights";
import type { Settings } from "@/types/settings";
import { AI_SCHEMA, AI_SYSTEM, factsPrompt, fit, parseAiAnswer, templateMetadata, type ClipFacts, type ClipMetadata, type DestinationMeta, type MetadataGenerator } from "./metadata";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
export const AI_KEYS_KEY = "sh.aiKeys";

export type OnDeviceState = "available" | "downloadable" | "downloading" | "unavailable" | "absent";

/** Chrome's Prompt API, wherever it runs (worker or offscreen document). */
export interface OnDevicePort {
  availability(): Promise<OnDeviceState>;
  prompt(system: string, user: string, schema: object): Promise<string>;
}

export interface AiKeys {
  anthropic: string | null;
  openai_compatible: string | null;
}

/** Keys stay in chrome.storage.local on this computer and are only sent to the provider you chose. */
export async function getAiKeys(): Promise<AiKeys> {
  const raw = ((await chrome.storage.local.get(AI_KEYS_KEY))[AI_KEYS_KEY] ?? {}) as Partial<AiKeys>;
  return { anthropic: typeof raw.anthropic === "string" && raw.anthropic ? raw.anthropic : null, openai_compatible: typeof raw.openai_compatible === "string" && raw.openai_compatible ? raw.openai_compatible : null };
}

export async function setAiKey(provider: keyof AiKeys, key: string | null): Promise<void> {
  const cur = await getAiKeys();
  const k = key?.trim() || null;
  if (k && (k.length < 8 || k.length > 300 || /\s/.test(k))) throw new Error("That doesn't look like an API key.");
  await chrome.storage.local.set({ [AI_KEYS_KEY]: { ...cur, [provider]: k } });
}

/** Chrome's built-in model, if this context has it (`LanguageModel`, Chrome 138+). */
export function localPromptApi(): OnDevicePort | null {
  const LM = (globalThis as { LanguageModel?: { availability(o?: object): Promise<string>; create(o?: object): Promise<{ prompt(t: string, o?: object): Promise<string>; destroy(): void }> } }).LanguageModel;
  if (!LM) return null;
  const opts = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
  return {
    async availability() {
      const a = await LM.availability(opts).catch(() => "unavailable");
      return (["available", "downloadable", "downloading", "unavailable"].includes(a) ? a : "unavailable") as OnDeviceState;
    },
    async prompt(system, user, schema) {
      const s = await LM.create({ ...opts, initialPrompts: [{ role: "system", content: system }] });
      try {
        return await s.prompt(user, { responseConstraint: schema });
      } finally {
        s.destroy();
      }
    },
  };
}

async function claude(key: string, model: string, f: ClipFacts): Promise<string> {
  // A browser extension calling the API directly with the editor's own key, stored on this computer only.
  const client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com", dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 60_000 });
  const res = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    // On a policy decline the API retries on a suitable fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: AI_SCHEMA as unknown as Record<string, unknown> } },
    system: AI_SYSTEM,
    messages: [{ role: "user", content: `Facts about the clip:\n${factsPrompt(f)}` }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined to write metadata for this clip.");
  if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off.");
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  if (!text) throw new Error("Claude returned no text.");
  return text;
}

export function claudeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Your Anthropic API key was rejected.";
  if (e instanceof Anthropic.PermissionDeniedError) return "Your Anthropic key can't use this model.";
  if (e instanceof Anthropic.NotFoundError) return "That Claude model doesn't exist (check Settings → AI).";
  if (e instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached; try again later.";
  if (e instanceof Anthropic.BadRequestError) return `Anthropic rejected the request (${e.message.slice(0, 120)}).`;
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic (network or missing permission).";
  if (e instanceof Anthropic.APIError) return `Anthropic error ${e.status ?? ""}`.trim();
  return e instanceof Error ? e.message : "Claude failed";
}

/** OpenAI-compatible Chat Completions (e.g. a local model server at http://localhost:11434/v1). */
async function openaiCompatible(endpoint: string, key: string | null, model: string, f: ClipFacts, fetchImpl: typeof fetch): Promise<string> {
  const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `${AI_SYSTEM}\nAnswer with JSON only, matching this schema: ${JSON.stringify(AI_SCHEMA)}` },
        { role: "user", content: `Facts about the clip:\n${factsPrompt(f)}` },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(`Your endpoint answered HTTP ${r.status}.`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error("Your endpoint returned no text.");
  return text.replace(/^```(?:json)?\s*|\s*```$/g, "");
}

export interface GenerateDeps {
  onDevice?: OnDevicePort | null;
  keys?: AiKeys;
  fetchImpl?: typeof fetch;
  /** For tests: replaces the Claude call. */
  claudeImpl?: (key: string, model: string, f: ClipFacts) => Promise<string>;
  now?: Date;
}

export async function generateMetadata(f: ClipFacts, settings: Settings, deps: GenerateDeps = {}, keep?: Partial<Record<Destination, DestinationMeta>>): Promise<ClipMetadata> {
  const fallbacks: string[] = [];
  const ai = settings.ai;
  let raw: Record<Destination, DestinationMeta> | null = null;
  let generator: MetadataGenerator = "template";

  if (ai.onDevice) {
    const port = deps.onDevice ?? null;
    const state = port ? await port.availability().catch(() => "unavailable" as const) : "absent";
    if (port && state === "available") {
      try {
        raw = parseAiAnswer(await port.prompt(AI_SYSTEM, `Facts about the clip:\n${factsPrompt(f)}`, AI_SCHEMA), f);
        generator = "on_device";
      } catch (e) {
        fallbacks.push(`On-device AI failed (${e instanceof Error ? e.message : "error"}).`);
      }
    } else fallbacks.push(state === "absent" ? "On-device AI isn't available in this Chrome." : state === "downloadable" || state === "downloading" ? "On-device AI model isn't downloaded yet (Settings → AI)." : "On-device AI isn't supported on this computer.");
  } else fallbacks.push("On-device AI is turned off.");

  if (!raw && ai.external !== "none") {
    const keys = deps.keys ?? (await getAiKeys());
    try {
      if (ai.external === "anthropic") {
        if (!keys.anthropic) throw new Error("No Anthropic API key saved.");
        raw = parseAiAnswer(await (deps.claudeImpl ?? claude)(keys.anthropic, ai.model || DEFAULT_CLAUDE_MODEL, f), f);
        generator = "anthropic";
      } else {
        if (!/^https?:\/\//.test(ai.endpoint)) throw new Error("No endpoint URL set.");
        if (!ai.model) throw new Error("No model name set.");
        raw = parseAiAnswer(await openaiCompatible(ai.endpoint, keys.openai_compatible, ai.model, f, deps.fetchImpl ?? fetch), f);
        generator = "openai_compatible";
      }
    } catch (e) {
      fallbacks.push(`${ai.external === "anthropic" ? "Claude" : "Your endpoint"}: ${ai.external === "anthropic" ? claudeError(e) : e instanceof Error ? e.message : "failed"}`);
    }
  }

  const base = raw ?? templateMetadata(f);
  const byDestination = {} as Record<Destination, DestinationMeta>;
  for (const d of ["youtube", "tiktok", "x"] as const) byDestination[d] = keep?.[d] ?? fit(d, base[d], f, settings.publishing.attribution);
  return { byDestination, generator, fallbacks, generated_at: (deps.now ?? new Date()).toISOString(), edited: (Object.keys(keep ?? {}) as Destination[]) };
}
