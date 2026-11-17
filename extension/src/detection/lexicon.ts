/**
 * Multilingual reaction vocabulary, bot list and text normalization.
 * Matching is on normalized tokens/phrases, so "LOOOL", "lol!!" and "Lol" are one phrase.
 */
import { CLIP_PHRASES, EMOTE_CATEGORIES, KNOWN_BOTS, REACTIONS } from "./lexicon-data";

export { EMOTE_CATEGORIES, KNOWN_BOTS, REACTIONS };

export const POSITIVE = new Set(["funny", "hype"]);
export const NEGATIVE = new Set(["sad", "shock"]);
export const LANGUAGES = Object.keys(REACTIONS);

const CHAR_RUN = /(.)\1{2,}/gsu; // "loool" → "lol"
const PAIR_RUN = /(..)\1{2,}/gsu; // "jajajaja" → "jaja"
const PUNCT = /[^\p{L}\p{N}\p{M}_\s']+/gu;

export function normalize(text: string): string {
  let t = text.normalize("NFKC").toLowerCase().trim();
  t = t.replace(PUNCT, " ");
  t = t.replace(CHAR_RUN, "$1");
  t = t.replace(PAIR_RUN, "$1$1");
  return t.replace(/\s+/gu, " ").trim();
}

export const hasInterrobang = (text: string) => text.includes("?!") || text.includes("!?");
export const isCommand = (text: string) => text.trimStart().startsWith("!");

/** Normalized phrase → category, for the enabled language packs (English first) + custom phrases. */
export function buildReactionIndex(languages: Iterable<string>, custom: Iterable<string>): Map<string, string> {
  const langs = [...new Set(languages)];
  const order = (langs.length ? langs : ["en"]).sort((a, b) => Number(a !== "en") - Number(b !== "en") || a.localeCompare(b));
  const index = new Map<string, string>();
  for (const lang of order) {
    for (const [category, phrases] of Object.entries(REACTIONS[lang] ?? {})) {
      for (const p of phrases) {
        const n = normalize(p);
        if (!index.has(n)) index.set(n, category);
      }
    }
  }
  for (const p of custom) {
    const n = normalize(p);
    if (n) index.set(n, "custom");
  }
  return index;
}

/** Categories whose phrases appear in the message as whole tokens / token sequences. */
export function matchReactions(norm: string, index: Map<string, string>, maxWords = 4): Set<string> {
  const tokens = norm.split(" ").filter(Boolean);
  const found = new Set<string>();
  for (let n = 1; n <= Math.min(maxWords, tokens.length); n++) {
    if (n === 1 && tokens.length > 3) continue; // single words count only in short messages
    for (let i = 0; i + n <= tokens.length; i++) {
      const cat = index.get(tokens.slice(i, i + n).join(" "));
      if (cat) found.add(cat);
    }
  }
  return found;
}

export function isClipRequest(norm: string): boolean {
  const tokens = norm.split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  const joined = tokens.slice(0, 4).join(" ");
  return CLIP_PHRASES.some((p) => joined === p || joined.startsWith(`${p} `)) || (tokens.length <= 4 && ["clip", "clipit"].includes(tokens[0]!));
}
