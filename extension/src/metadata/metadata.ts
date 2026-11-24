/**
 * Titles, descriptions and hashtags per destination (3.0 phase 6). Everything is built from facts
 * StreamHunter actually has about a clip (creator, platform, category, why it was detected,
 * duration, the original link); generators may phrase them but never add events, quotes or numbers.
 */
import type { Destination } from "@/local/rights";
import type { LocalClip } from "@/local/clips";
import type { Platform } from "@/types/api";

export interface ClipFacts {
  clipTitle: string | null;
  creator: string;
  platform: Platform | "local";
  category: string | null;
  reasons: string[];
  durationSec: number | null;
  originalUrl: string | null;
  /** 4.4: exact spoken lines from the transcript (seconds into the clip). */
  quotes?: { at: number; text: string }[];
}

export interface DestinationMeta {
  /** YouTube title; TikTok and X have none (empty). */
  title: string;
  /** YouTube description, TikTok caption, X post text (hashtags appended when published). */
  description: string;
  hashtags: string[];
}

export type MetadataGenerator = "on_device" | "anthropic" | "openai_compatible" | "template";
export const GENERATOR_LABEL: Record<MetadataGenerator, string> = {
  on_device: "On-device AI (Chrome)",
  anthropic: "Claude (your Anthropic key)",
  openai_compatible: "Your OpenAI-compatible endpoint",
  template: "Local templates",
};

export interface ClipMetadata {
  byDestination: Record<Destination, DestinationMeta>;
  generator: MetadataGenerator;
  /** Why earlier options in the fallback order weren't used. */
  fallbacks: string[];
  generated_at: string;
  /** Destinations you edited by hand (kept when metadata is regenerated). */
  edited: Destination[];
}

const PLATFORM_NAME: Record<ClipFacts["platform"], string> = { twitch: "Twitch", kick: "Kick", youtube: "YouTube", local: "" };

/** Platform limits (documented): YouTube title 100 / description 5000; TikTok caption 2200; X post 280 (a link counts as 23). */
export const LIMITS: Record<Destination, { title: number; text: number; hashtags: number }> = {
  youtube: { title: 100, text: 5000, hashtags: 5 },
  tiktok: { title: 0, text: 2200, hashtags: 5 },
  x: { title: 0, text: 280, hashtags: 2 },
};
const X_LINK = 23;

export function factsOf(clip: LocalClip & { original_url?: string | null }, streamer?: { username?: string; platform?: Platform } | null): ClipFacts {
  const original =
    clip.original_url ??
    (streamer?.username && clip.platform === "twitch" ? `https://www.twitch.tv/${streamer.username}` : streamer?.username && clip.platform === "kick" ? `https://kick.com/${streamer.username}` : null);
  return {
    clipTitle: clip.title && !/^Clip \d|^Untitled/i.test(clip.title) ? clip.title : null,
    creator: clip.streamer_display_name,
    platform: (clip.platform as ClipFacts["platform"]) ?? "local",
    category: clip.category && !/^(unknown|other)$/i.test(clip.category) ? clip.category : null,
    reasons: (clip.reasons ?? []).filter((r) => r && !/^Saved by you$/i.test(r)).slice(0, 4),
    durationSec: clip.duration_seconds,
    originalUrl: original,
  };
}

/** "#Valorant" from "Valorant", "#JustChatting" from "Just Chatting"; letters and digits only. */
export function hashtag(s: string): string | null {
  const t = s
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toLocaleUpperCase() + w.slice(1))
    .join("");
  return t.length >= 2 && t.length <= 40 ? `#${t}` : null;
}

function cleanTags(tags: string[], max: number): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const h = hashtag(t.replace(/^#/, ""));
    if (h && !out.some((x) => x.toLowerCase() === h.toLowerCase())) out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

export function attributionLine(f: ClipFacts): string {
  const where = PLATFORM_NAME[f.platform];
  return `Credit: ${f.creator}${where ? ` on ${where}` : ""}${f.originalUrl ? ` ${f.originalUrl}` : ""}`;
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`);

/**
 * Enforces each platform's limits and adds attribution (when enabled). Applied to every generator's
 * output, including AI and your own edits.
 */
export function fit(dest: Destination, m: DestinationMeta, f: ClipFacts, attribution: boolean): DestinationMeta {
  const L = LIMITS[dest];
  const tags = cleanTags(m.hashtags, L.hashtags);
  const title = L.title ? cut(m.title.replace(/\s+/g, " ").trim() || `${f.creator} clip`, L.title) : "";
  const credit = attribution ? attributionLine(f) : "";
  let text = m.description.trim();
  if (credit && !text.includes(f.creator)) text = text ? `${text}\n\n${credit}` : credit;
  else if (credit && f.originalUrl && !text.includes(f.originalUrl)) text = `${text}\n\n${credit}`;
  if (dest === "x") {
    // X counts every link as 23 characters; hashtags are appended with spaces.
    const tagLen = tags.reduce((a, t) => a + t.length + 1, 0);
    const links = text.match(/https?:\/\/\S+/g) ?? [];
    const visible = text.length - links.reduce((a, l) => a + l.length, 0) + links.length * X_LINK;
    if (visible + tagLen > L.text) {
      const room = L.text - tagLen - links.length * (X_LINK + 1);
      const plain = text.replace(/\s*https?:\/\/\S+/g, "");
      text = `${cut(plain, Math.max(10, room))}${links.length ? ` ${links.join(" ")}` : ""}`;
    }
  } else {
    const tagLen = tags.reduce((a, t) => a + t.length + 1, 0);
    text = cut(text, L.text - tagLen - 2);
  }
  return { title, description: text, hashtags: tags };
}

/** X: how long the post will be, counted the way X counts it. */
export function xLength(m: DestinationMeta): number {
  const text = [m.description, ...m.hashtags].join(" ");
  const links = text.match(/https?:\/\/\S+/g) ?? [];
  return text.length - links.reduce((a, l) => a + l.length, 0) + links.length * X_LINK;
}

/** Local templates: plain, factual, always available. */
export function templateMetadata(f: ClipFacts): Record<Destination, DestinationMeta> {
  const what = f.reasons[0] ? f.reasons[0].replace(/\.$/, "") : null;
  const topic = f.clipTitle ?? (f.category ? `${f.creator} – ${f.category}` : `${f.creator} highlight`);
  const tags = [f.creator, ...(f.category ? [f.category] : []), ...(f.platform !== "local" ? [PLATFORM_NAME[f.platform]] : [])];
  const line = [what && `${what}.`, f.category && `Playing ${f.category}.`].filter(Boolean).join(" ");
  return {
    youtube: { title: topic, description: [line, `Highlight from ${f.creator}'s stream.`].filter(Boolean).join("\n"), hashtags: ["Shorts", ...tags] },
    tiktok: { title: "", description: [topic, line].filter(Boolean).join(" · "), hashtags: tags },
    x: { title: "", description: f.clipTitle ? f.clipTitle : what ? `${f.creator}: ${what}` : `${f.creator}${f.category ? ` in ${f.category}` : ""}`, hashtags: tags.slice(0, 2) },
  };
}

/** The facts as the AI generators see them. */
export function factsPrompt(f: ClipFacts): string {
  return [
    `Creator: ${f.creator}`,
    f.platform !== "local" && `Streamed on: ${PLATFORM_NAME[f.platform]}`,
    f.category && `Game or category: ${f.category}`,
    f.clipTitle && `Clip title chosen by the editor: ${f.clipTitle}`,
    f.reasons.length && `Why the moment was detected (measured): ${f.reasons.join("; ")}`,
    f.durationSec && `Clip length: ${Math.round(f.durationSec)} seconds`,
    f.quotes?.length &&
      `What is said in the clip (transcribed on this computer; exact words, quote them only as written):\n${f.quotes.map((q) => `[${Math.floor(q.at / 60)}:${String(Math.floor(q.at % 60)).padStart(2, "0")}] "${q.text}"`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const AI_SYSTEM = `You write titles, captions and hashtags for short gaming and livestream clips.
Use only the facts you are given. Never invent events, quotes, numbers, results, names or claims that aren't in the facts; if the facts are thin, write something short and neutral instead.
Don't use clickbait that the facts don't support, don't promise outcomes, and don't mention AI.
YouTube Shorts: title up to 90 characters, description up to 300 characters, up to 4 hashtags.
TikTok: caption up to 300 characters, up to 4 hashtags.
X: post text up to 200 characters, up to 2 hashtags.
Hashtags are single words without spaces; leave out the # sign.`;

/** JSON schema the AI generators must return. */
export const AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["youtube", "tiktok", "x"],
  properties: {
    youtube: { type: "object", additionalProperties: false, required: ["title", "description", "hashtags"], properties: { title: { type: "string" }, description: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } } },
    tiktok: { type: "object", additionalProperties: false, required: ["caption", "hashtags"], properties: { caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } } },
    x: { type: "object", additionalProperties: false, required: ["text", "hashtags"], properties: { text: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } } },
  },
} as const;

/** Parses and checks an AI answer; throws when it doesn't match the schema. */
export function parseAiAnswer(raw: string, f: ClipFacts): Record<Destination, DestinationMeta> {
  const j = JSON.parse(raw) as { youtube?: { title?: unknown; description?: unknown; hashtags?: unknown }; tiktok?: { caption?: unknown; hashtags?: unknown }; x?: { text?: unknown; hashtags?: unknown } };
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  const yt = j.youtube, tt = j.tiktok, x = j.x;
  const out = {
    youtube: { title: str(yt?.title), description: str(yt?.description), hashtags: arr(yt?.hashtags) },
    tiktok: { title: "", description: str(tt?.caption), hashtags: arr(tt?.hashtags) },
    x: { title: "", description: str(x?.text), hashtags: arr(x?.hashtags) },
  };
  for (const [k, v] of Object.entries(out)) if (v.title === null || v.description === null || v.hashtags === null) throw new Error(`The answer is missing ${k} fields`);
  // Guard against invented links: only the original link may appear.
  const noLinks = (s: string) => s.replace(/https?:\/\/\S+/g, (u) => (f.originalUrl && u.startsWith(f.originalUrl) ? u : "")).trim();
  return {
    youtube: { title: noLinks(out.youtube.title!), description: noLinks(out.youtube.description!), hashtags: out.youtube.hashtags! },
    tiktok: { title: "", description: noLinks(out.tiktok.description!), hashtags: out.tiktok.hashtags! },
    x: { title: "", description: noLinks(out.x.description!), hashtags: out.x.hashtags! },
  };
}
