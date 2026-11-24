/**
 * 3.0 phase 6: metadata (templates, platform limits, AI answers, the fallback order, your edits)
 * and the viral-potential score (math, tiers, explanations, confidence).
 * Providers are faked here; nothing calls a real API.
 */
import { DEFAULT_SETTINGS, type Settings } from "@/types/settings";
import { saveClip, type LocalClip } from "@/local/clips";
import { db } from "@/local/db";
import { editMetadata, prepareContent, ContentError, type ContentClip } from "@/local/content";
import { scoreClip, platformFit } from "@/scoring/score";
import { attributionLine, fit, hashtag, LIMITS, parseAiAnswer, templateMetadata, xLength, type ClipFacts } from "./metadata";
import { generateMetadata, getAiKeys, setAiKey, type OnDevicePort } from "./generate";

const settings = (patch: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  patch(s);
  return s;
};

const facts: ClipFacts = {
  clipTitle: null,
  creator: "Aria",
  platform: "twitch",
  category: "Just Chatting",
  reasons: ["Loud laughter", "Chat spiked 4×"],
  durationSec: 30,
  originalUrl: "https://www.twitch.tv/aria",
};

const aiAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    youtube: { title: "Aria can't stop laughing", description: "Chat lost it too.", hashtags: ["Aria", "JustChatting"] },
    tiktok: { caption: "Aria's laugh 😂", hashtags: ["aria", "twitch"] },
    x: { text: "Aria loses it on stream", hashtags: ["Aria"] },
    ...over,
  });

describe("metadata: templates and platform limits", () => {
  it("templates use only the facts and credit the creator with the original link", () => {
    const t = templateMetadata(facts);
    const yt = fit("youtube", t.youtube, facts, true);
    expect(yt.title).toBe("Aria – Just Chatting");
    expect(yt.description).toContain("Loud laughter.");
    expect(yt.description).toContain(attributionLine(facts));
    expect(attributionLine(facts)).toBe("Credit: Aria on Twitch https://www.twitch.tv/aria");
    expect(yt.hashtags).toEqual(["#Shorts", "#Aria", "#JustChatting", "#Twitch"]);
    const x = fit("x", t.x, facts, true);
    expect(x.hashtags.length).toBeLessThanOrEqual(LIMITS.x.hashtags);
    expect(xLength(x)).toBeLessThanOrEqual(280);
  });

  it("attribution can be turned off", () => {
    const t = templateMetadata({ ...facts, reasons: [] });
    expect(fit("tiktok", t.tiktok, facts, false).description).not.toContain("Credit:");
  });

  it("hashtags are cleaned, de-duplicated and capped", () => {
    expect(hashtag("Just Chatting")).toBe("#JustChatting");
    expect(hashtag("#gg!")).toBe("#Gg");
    expect(hashtag("x")).toBeNull();
    const m = fit("youtube", { title: "t", description: "d", hashtags: ["a b", "AB", "ab", "one", "two", "three", "four", "five"] }, facts, false);
    expect(m.hashtags).toEqual(["#AB", "#One", "#Two", "#Three", "#Four"]);
  });

  it("YouTube title ≤ 100, TikTok caption ≤ 2200, X post ≤ 280 counted the X way", () => {
    const long = "word ".repeat(1200);
    expect(fit("youtube", { title: long, description: long, hashtags: [] }, facts, true).title.length).toBeLessThanOrEqual(100);
    expect(fit("youtube", { title: "", description: long, hashtags: [] }, facts, false).description.length).toBeLessThanOrEqual(5000);
    expect(fit("tiktok", { title: "", description: long, hashtags: ["a1", "b2"] }, facts, true).description.length).toBeLessThanOrEqual(2200);
    const x = fit("x", { title: "", description: `${long} https://www.twitch.tv/aria`, hashtags: ["Aria", "Twitch"] }, facts, true);
    expect(xLength(x)).toBeLessThanOrEqual(280);
    expect(x.description).toContain("https://www.twitch.tv/aria"); // the link survives the cut
  });

  it("X counts a link as 23 characters", () => {
    expect(xLength({ title: "", description: "hi https://example.com/a/very/long/path/that/is/long", hashtags: [] })).toBe(3 + 23);
    expect(xLength({ title: "", description: "hi", hashtags: ["#A"] })).toBe(5);
  });

  it("a blank YouTube title falls back to the creator", () => {
    expect(fit("youtube", { title: "  ", description: "", hashtags: [] }, facts, false).title).toBe("Aria clip");
  });
});

describe("metadata: AI answers", () => {
  it("parses a schema-shaped answer", () => {
    const r = parseAiAnswer(aiAnswer(), facts);
    expect(r.youtube.title).toBe("Aria can't stop laughing");
    expect(r.tiktok).toEqual({ title: "", description: "Aria's laugh 😂", hashtags: ["aria", "twitch"] });
    expect(r.x.description).toBe("Aria loses it on stream");
  });

  it("rejects answers missing fields or not JSON", () => {
    expect(() => parseAiAnswer(aiAnswer({ x: { hashtags: [] } }), facts)).toThrow(/missing x/);
    expect(() => parseAiAnswer("Sure! Here you go", facts)).toThrow();
  });

  it("removes links the AI invented but keeps the original link", () => {
    const r = parseAiAnswer(aiAnswer({ x: { text: "Watch https://evil.example/x and https://www.twitch.tv/aria", hashtags: [] } }), facts);
    expect(r.x.description).not.toContain("evil.example");
    expect(r.x.description).toContain("https://www.twitch.tv/aria");
  });
});

const port = (state: Awaited<ReturnType<OnDevicePort["availability"]>>, answer: () => Promise<string>): OnDevicePort & { calls: number } => {
  const p = {
    calls: 0,
    availability: async () => state,
    prompt: async () => {
      p.calls++;
      return answer();
    },
  };
  return p;
};

describe("metadata: fallback order on-device → your provider → templates", () => {
  const noKeys = { anthropic: null, openai_compatible: null };

  it("uses on-device AI when it's available", async () => {
    const p = port("available", async () => aiAnswer());
    const m = await generateMetadata(facts, settings(), { onDevice: p, keys: noKeys });
    expect(m.generator).toBe("on_device");
    expect(m.fallbacks).toEqual([]);
    expect(m.byDestination.youtube.title).toBe("Aria can't stop laughing");
    expect(m.byDestination.youtube.description).toContain("Credit: Aria on Twitch"); // limits and credit still applied
  });

  it("falls to your Claude key when on-device isn't downloaded, recording why", async () => {
    const seen: string[] = [];
    const m = await generateMetadata(facts, settings((s) => ((s.ai.external = "anthropic"), (s.ai.model = ""))), {
      onDevice: port("downloadable", async () => aiAnswer()),
      keys: { anthropic: "sk-ant-test-123", openai_compatible: null },
      claudeImpl: async (key, model) => (seen.push(`${key}|${model}`), aiAnswer()),
    });
    expect(m.generator).toBe("anthropic");
    expect(seen).toEqual(["sk-ant-test-123|claude-opus-5-5"]);
    expect(m.fallbacks[0]).toMatch(/isn't downloaded/);
  });

  it("falls to templates when on-device fails and the provider has no key", async () => {
    const m = await generateMetadata(facts, settings((s) => (s.ai.external = "anthropic")), { onDevice: port("available", async () => "not json"), keys: noKeys });
    expect(m.generator).toBe("template");
    expect(m.fallbacks).toHaveLength(2);
    expect(m.fallbacks[0]).toMatch(/On-device AI failed/);
    expect(m.fallbacks[1]).toMatch(/No Anthropic API key/);
    expect(m.byDestination.youtube.title).toBe("Aria – Just Chatting");
  });

  it("a Claude failure (e.g. refusal) is recorded and templates are used", async () => {
    const m = await generateMetadata(facts, settings((s) => ((s.ai.onDevice = false), (s.ai.external = "anthropic"))), {
      keys: { anthropic: "sk-ant-test-123", openai_compatible: null },
      claudeImpl: async () => {
        throw new Error("Claude declined to write metadata for this clip.");
      },
    });
    expect(m.generator).toBe("template");
    expect(m.fallbacks).toEqual(["On-device AI is turned off.", "Claude: Claude declined to write metadata for this clip."]);
  });

  it("calls an OpenAI-compatible endpoint with your key and model", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + aiAnswer() + "\n```" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const m = await generateMetadata(facts, settings((s) => ((s.ai.onDevice = false), (s.ai.external = "openai_compatible"), (s.ai.endpoint = "http://localhost:11434/v1/"), (s.ai.model = "llama3"))), {
      keys: { anthropic: null, openai_compatible: "local-key-1" },
      fetchImpl,
    });
    expect(m.generator).toBe("openai_compatible");
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer local-key-1");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("llama3");
    expect(body.messages[1].content).toContain("Creator: Aria");
  });

  it("an endpoint error falls back to templates", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const m = await generateMetadata(facts, settings((s) => ((s.ai.onDevice = false), (s.ai.external = "openai_compatible"), (s.ai.endpoint = "http://localhost:1/v1"), (s.ai.model = "m"))), { keys: { anthropic: null, openai_compatible: null }, fetchImpl });
    expect(m.generator).toBe("template");
    expect(m.fallbacks[1]).toBe("Your endpoint: Your endpoint answered HTTP 500.");
  });

  it("sends the Claude request through the official SDK with your key (fake API)", async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const msg = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: aiAnswer() }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const m = await generateMetadata(facts, settings((s) => ((s.ai.onDevice = false), (s.ai.external = "anthropic"))), { keys: { anthropic: "sk-ant-test-123", openai_compatible: null } });
      expect(m.generator).toBe("anthropic");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(r.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(r.headers.get("authorization")).toBe("Bearer sk-ant-test-123"); // the SDK sends apiKey as a bearer token
    expect(r.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(r.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(JSON.stringify(r.body.messages)).toContain("Creator: Aria");
    expect(JSON.stringify(r.body)).not.toContain("blob"); // facts only, never video
  });

  it("your edits survive regeneration", async () => {
    const keep = { x: { title: "", description: "My own post", hashtags: ["#Mine"] } };
    const m = await generateMetadata(facts, settings(), { onDevice: null }, keep);
    expect(m.byDestination.x.description).toBe("My own post");
    expect(m.edited).toEqual(["x"]);
  });
});

describe("AI keys", () => {
  it("are stored locally, trimmed, validated and removable", async () => {
    await setAiKey("anthropic", "  sk-ant-abcdef123  ");
    expect((await getAiKeys()).anthropic).toBe("sk-ant-abcdef123");
    await expect(setAiKey("anthropic", "has space inside")).rejects.toThrow(/doesn't look like/);
    await setAiKey("anthropic", null);
    expect((await getAiKeys()).anthropic).toBeNull();
  });
});

type ScoreInput = Parameters<typeof scoreClip>[0];
const detected = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  score: 90,
  score_parts: { audio: 95, chat: 92, visual: 60, viewers: 70, multi: 1 },
  confidence: 0.9,
  event_seconds: 4,
  reasons: ["Loud laughter", "Chat: clip it!"],
  detection_types: ["audio", "chat"],
  duration_seconds: 30,
  started_at: "2026-11-01T10:00:00.000Z",
  peak_at: "2026-11-01T10:00:08.000Z",
  category: "Funny",
  ...over,
});
const vertical = { kind: "vertical" as const, status: "ready" as const, duration_seconds: 30, used_layout: "facecam_top" as const, width: 1080, height: 1920 };
const landscape = { kind: "landscape" as const, status: "ready" as const, duration_seconds: 30, used_layout: "landscape" as const, width: 1920, height: 1080 };

describe("viral-potential score", () => {
  it("is the weighted average of six explained factors", () => {
    const s = scoreClip(detected(), [vertical, landscape], settings());
    expect(s.factors.map((f) => f.key)).toEqual(["hook", "emotion", "engagement", "story", "share", "platform"]);
    const w = s.factors.reduce((a, f) => a + f.weight, 0);
    expect(s.total).toBe(Math.round(s.factors.reduce((a, f) => a + f.points * f.weight, 0) / w));
    for (const f of s.factors) expect(f.inputs.length).toBeGreaterThan(0);
    expect(s.factors.find((f) => f.key === "hook")!.inputs[0]).toBe("Peak 8 s into a 30 s clip");
  });

  it("strong measured clips are high; the threshold is yours", () => {
    const s = scoreClip(detected(), [vertical, landscape], settings());
    expect(s.total).toBeGreaterThanOrEqual(85);
    expect(s.tier).toBe("high");
    expect(s.summary).toMatch(/strong candidate to upload/);
    const stricter = scoreClip(detected(), [vertical, landscape], settings((x) => (x.scoring.highThreshold = 99)));
    expect(stricter.tier).toBe("medium");
    expect(stricter.summary).toMatch(/worth reviewing/);
  });

  it("weights change the score", () => {
    const base = scoreClip(detected(), [vertical], settings());
    const platformOnly = scoreClip(detected(), [vertical], settings((x) => (x.scoring.weights = { hook: 0, emotion: 0, engagement: 0, story: 0, share: 0, platform: 1 })));
    expect(platformOnly.total).toBe(platformOnly.factors.find((f) => f.key === "platform")!.points);
    expect(platformOnly.total).not.toBe(base.total);
  });

  it("weak clips are low", () => {
    const s = scoreClip(detected({ score_parts: { audio: 10, chat: 5, visual: 5, viewers: 0, multi: 0 }, reasons: [], detection_types: ["audio"], category: null, event_seconds: 0 }), [], settings());
    expect(s.tier).toBe("low");
  });

  it("high scores with low confidence become medium", () => {
    // A manual clip from a file: nothing about the live audience was measured.
    const s = scoreClip(detected({ confidence: 0.4 }), [vertical, landscape], settings((x) => (x.scoring.highThreshold = 50)));
    expect(s.total).toBeGreaterThanOrEqual(50);
    expect(s.confidence).toBeLessThan(0.5);
    expect(s.tier).toBe("medium");
    expect(s.summary).toMatch(/confidence is only/);
  });

  it("unmeasured factors are flagged and lower the confidence", () => {
    const manual = scoreClip({ score: 0, score_parts: null, confidence: null as unknown as number, event_seconds: null as unknown as number, reasons: [], detection_types: ["manual"], duration_seconds: 20, started_at: null as unknown as string, peak_at: null, category: null }, [], settings());
    expect(manual.factors.find((f) => f.key === "engagement")!.measured).toBe(false);
    expect(manual.factors.find((f) => f.key === "engagement")!.inputs[0]).toMatch(/No live audience data/);
    expect(manual.confidence).toBe(0);
    expect(manual.tier).toBe("low");
  });

  it("platform fit reflects length and layout per destination", () => {
    expect(platformFit("youtube", vertical).points).toBe(100);
    expect(platformFit("tiktok", { ...vertical, used_layout: "center" }).points).toBe(85);
    expect(platformFit("x", { ...landscape, duration_seconds: 200 }).points).toBe(0);
    expect(platformFit("x", undefined).inputs[0]).toBe("No landscape version yet");
  });
});

describe("clip content (stored on the clip)", () => {
  const clip = async (): Promise<LocalClip> =>
    saveClip({ candidateId: 0, sessionId: null, streamerId: 0, streamerName: "Aria", platform: "twitch", title: "Clip 1", startedAt: Date.parse("2026-11-01T10:00:00Z"), durationSec: 30, width: 1920, height: 1080, score: 80, blob: new Blob(["v"]), category: "Just Chatting", reasons: ["Loud laughter"], peakAt: Date.parse("2026-11-01T10:00:08Z") });

  it("prepares score and metadata, keeps your edits on regenerate, resets on request", async () => {
    const c = await clip();
    const s = settings((x) => (x.ai.onDevice = false));
    const first = await prepareContent(c.id, s);
    expect(first.metadata!.generator).toBe("template");
    expect(first.viral!.factors).toHaveLength(6);

    const edited = await editMetadata(c.id, "x", { description: "My own post" }, s);
    expect(edited.metadata!.byDestination.x.description).toContain("My own post");
    expect(edited.metadata!.byDestination.x.description).toContain("Credit: Aria on Twitch"); // credit still applied
    expect(edited.metadata!.edited).toEqual(["x"]);

    const again = await prepareContent(c.id, s, {}, { regenerate: true });
    expect(again.metadata!.byDestination.x.description).toContain("My own post");
    expect(again.metadata!.byDestination.youtube.title).toBe("Aria – Just Chatting");

    const reset = await prepareContent(c.id, s, {}, { regenerate: true, resetEdits: true });
    expect(reset.metadata!.byDestination.x.description).not.toContain("My own post");
    expect(reset.metadata!.edited).toEqual([]);
    expect((await db.get<ContentClip>("clips", c.id))!.metadata!.edited).toEqual([]);
  });

  it("edits are refused before metadata exists or for unknown destinations", async () => {
    const c = await clip();
    await expect(editMetadata(c.id, "x", { description: "x" }, settings())).rejects.toBeInstanceOf(ContentError);
    await expect(editMetadata(c.id, "myspace" as "x", {}, settings())).rejects.toThrow(/Unknown destination/);
    await expect(prepareContent(99999, settings())).rejects.toThrow(/no longer exists/);
  });
});

describe("clips cut from a video file", () => {
  it("say “video”, not “stream”", () => {
    const f = { clipTitle: null, creator: "My Channel", platform: "youtube" as const, category: null, reasons: ["Loud reaction"], durationSec: 30, originalUrl: "https://www.youtube.com/watch?v=aaaaaaaaaa1" };
    expect(templateMetadata({ ...f, fromVideo: true }).youtube.description).toBe("Loud reaction.\nFrom My Channel's video.");
    expect(templateMetadata(f).youtube.description).toBe("Loud reaction.\nHighlight from My Channel's stream.");
  });
});
