"""Multilingual reaction vocabulary, bot list and text normalization.

Kept deliberately small and editable. Matching is on normalized tokens/phrases, so a
single list covers variants like "LOOOL", "lol!!" and "Lol". Users add their own phrases
in Settings (detection.customKeywords); those count as reactions.
"""

from __future__ import annotations

import re
import unicodedata

# category -> phrases. Categories map to highlight categories in scoring_engine.
REACTIONS: dict[str, dict[str, tuple[str, ...]]] = {
    "en": {
        "funny": ("lol", "lmao", "lmfao", "rofl", "haha", "hahaha", "dead", "im dead", "i cant", "crying"),
        "shock": ("omg", "no way", "what", "wtf", "wait what", "bro what", "huh", "nah", "holy", "insane", "?!"),
        "hype": ("lets go", "letsgo", "gg", "w", "huge", "clutch", "goated", "sheesh", "fire", "banger"),
        "sad": ("f", "rip", "sad", "pain", "oof"),
    },
    "es": {
        "funny": ("jaja", "jajaja", "jsjs", "xd", "me muero"),
        "shock": ("que", "qué", "no puede ser", "increible", "increíble", "madre mia", "madre mía"),
        "hype": ("vamos", "golazo", "que crack", "brutal", "epico", "épico"),
        "sad": ("f", "rip", "que pena", "triste"),
    },
    "pt": {
        "funny": ("kkkk", "kkk", "kkkkk", "rsrs", "hahaha", "morri"),
        "shock": ("mds", "meu deus", "que isso", "nao acredito", "não acredito", "caraca"),
        "hype": ("bora", "vamo", "brabo", "monstro", "absurdo"),
        "sad": ("f", "rip", "triste"),
    },
    "fr": {
        "funny": ("mdr", "ptdr", "xptdr", "jpp", "hahaha"),
        "shock": ("quoi", "hein", "wesh", "cest pas possible", "c'est pas possible", "oh la"),
        "hype": ("allez", "trop fort", "incroyable", "enorme", "énorme"),
        "sad": ("f", "rip", "dommage", "triste"),
    },
    "de": {
        "funny": ("haha", "hahaha", "lol", "xd"),
        "shock": ("was", "krass", "alter", "digga", "wie bitte"),
        "hype": ("geil", "los gehts", "stark", "ehrenmann"),
        "sad": ("f", "rip", "schade", "traurig"),
    },
    "it": {
        "funny": ("ahah", "ahahah", "ahahahah", "xd"),
        "shock": ("cosa", "ma che", "non ci credo", "assurdo"),
        "hype": ("forza", "dai", "grande", "fortissimo"),
        "sad": ("f", "rip", "peccato", "triste"),
    },
    "ar": {
        "funny": ("هههه", "ههههه", "ههه", "اضحك"),
        "shock": ("ايش", "شنو", "والله", "مستحيل", "يا الله"),
        "hype": ("يلا", "كفو", "اسطورة", "وحش"),
        "sad": ("للاسف", "حرام", "rip"),
    },
    "tr": {
        "funny": ("sjsjsj", "ahahah", "kdkdkd", "asdfgh"),
        "shock": ("ne", "nasil", "nasıl", "inanmiyorum", "inanmıyorum", "oha"),
        "hype": ("hadi", "helal", "efsane", "kral"),
        "sad": ("f", "rip", "yazik", "yazık"),
    },
}

# "Clip that" requests, language independent enough to apply always.
CLIP_PHRASES: tuple[str, ...] = (
    "clip", "clip it", "clip that", "clipped", "clip this", "clippen", "clipa", "clipalo", "clípalo",
    "clipea", "clipper", "clippe", "klip", "clipe", "clipei",
)

# Well-known emotes (Twitch first-party, BTTV/7TV/FFZ staples, common Kick emotes) → category.
EMOTE_CATEGORIES: dict[str, str] = {
    **dict.fromkeys(("kekw", "lul", "lulw", "omegalul", "kekl", "icant", "lmao", "pepelaugh", "4head", "kappa",
                     "emotelaugh", "emojilaughing"), "funny"),
    **dict.fromkeys(("monkas", "wutface", "dansgame", "notlikethis", "kreygasm", "pogo", "modcheck", "aware",
                     "emotesurprised", "emojishocked"), "shock"),
    **dict.fromkeys(("pogchamp", "pog", "poggers", "pogu", "letsgo", "ez", "clap", "catjam", "emotehype",
                     "emojifire", "gigachad"), "hype"),
    **dict.fromkeys(("biblethump", "sadge", "pepehands", "feelsbadman", "prayge", "emotesad", "emojicrying"), "sad"),
}

POSITIVE = {"funny", "hype"}
NEGATIVE = {"sad", "shock"}

# Chat bots never count as audience reactions.
KNOWN_BOTS: frozenset[str] = frozenset(
    {"nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "botrixoficial", "kickbot",
     "sery_bot", "soundalerts", "commanderroot", "kofistreambot", "streamstickers", "pokemoncommunitygame"}
)

_CHAR_RUN = re.compile(r"(.)\1{2,}")  # "loool" → "lol", "kkkkk" → "k", "mdrrrr" → "mdr"
_PAIR_RUN = re.compile(r"(..)\1{2,}")  # "jajajaja" → "jaja", "hahahaha" → "haha"
_PUNCT = re.compile(r"[^\w\s']+", re.UNICODE)
_SPACES = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Casefold, drop punctuation, and squash elongations so variants match one phrase.

    Applied to both chat messages and the lexicon, so "LOOOOL!!", "lol" and "Lol?" are equal.
    """
    t = unicodedata.normalize("NFKC", text).casefold().strip()
    t = _PUNCT.sub(" ", t)
    t = _CHAR_RUN.sub(r"\1", t)
    t = _PAIR_RUN.sub(r"\1\1", t)
    return _SPACES.sub(" ", t).strip()


def has_interrobang(text: str) -> bool:
    return "?!" in text or "!?" in text


def is_command(text: str) -> bool:
    return text.lstrip().startswith("!")


def build_reaction_index(languages: set[str], custom: set[str]) -> dict[str, str]:
    """phrase (normalized) → category, for the given language packs + custom phrases.

    Packs are applied in a fixed order (English first, then alphabetical) so the result never
    depends on set iteration order; the first pack defining a phrase wins.
    """
    index: dict[str, str] = {}
    for lang in sorted(languages or {"en"}, key=lambda c: (c != "en", c)):
        for category, phrases in REACTIONS.get(lang, {}).items():
            for p in phrases:
                index.setdefault(normalize(p), category)
    for p in custom:
        n = normalize(p)
        if n:
            index[n] = "custom"
    return index


def match_reactions(norm_text: str, index: dict[str, str], max_phrase_words: int = 4) -> set[str]:
    """Categories whose phrases appear in the message (as whole tokens / token sequences)."""
    tokens = norm_text.split()
    found: set[str] = set()
    for n in range(1, min(max_phrase_words, len(tokens)) + 1):
        # Single words ("que", "was", "w") are reactions only in short messages; in a sentence
        # they're just words.
        if n == 1 and len(tokens) > 3:
            continue
        for i in range(len(tokens) - n + 1):
            cat = index.get(" ".join(tokens[i : i + n]))
            if cat:
                found.add(cat)
    return found


def is_clip_request(norm_text: str) -> bool:
    tokens = norm_text.split()
    if not tokens:
        return False
    joined = " ".join(tokens[:4])
    return any(joined == p or joined.startswith(p + " ") for p in CLIP_PHRASES) or (
        len(tokens) <= 4 and tokens[0] in {"clip", "clipit"}
    )
