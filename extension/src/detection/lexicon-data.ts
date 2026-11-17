/** Reaction vocabulary (ported unchanged from the original backend's lexicon). Editable. */
export const REACTIONS: Record<string, Record<string, readonly string[]>> = {
  "en": {
    "funny": [
      "lol",
      "lmao",
      "lmfao",
      "rofl",
      "haha",
      "hahaha",
      "dead",
      "im dead",
      "i cant",
      "crying"
    ],
    "shock": [
      "omg",
      "no way",
      "what",
      "wtf",
      "wait what",
      "bro what",
      "huh",
      "nah",
      "holy",
      "insane",
      "?!"
    ],
    "hype": [
      "lets go",
      "letsgo",
      "gg",
      "w",
      "huge",
      "clutch",
      "goated",
      "sheesh",
      "fire",
      "banger"
    ],
    "sad": [
      "f",
      "rip",
      "sad",
      "pain",
      "oof"
    ]
  },
  "es": {
    "funny": [
      "jaja",
      "jajaja",
      "jsjs",
      "xd",
      "me muero"
    ],
    "shock": [
      "que",
      "qué",
      "no puede ser",
      "increible",
      "increíble",
      "madre mia",
      "madre mía"
    ],
    "hype": [
      "vamos",
      "golazo",
      "que crack",
      "brutal",
      "epico",
      "épico"
    ],
    "sad": [
      "f",
      "rip",
      "que pena",
      "triste"
    ]
  },
  "pt": {
    "funny": [
      "kkkk",
      "kkk",
      "kkkkk",
      "rsrs",
      "hahaha",
      "morri"
    ],
    "shock": [
      "mds",
      "meu deus",
      "que isso",
      "nao acredito",
      "não acredito",
      "caraca"
    ],
    "hype": [
      "bora",
      "vamo",
      "brabo",
      "monstro",
      "absurdo"
    ],
    "sad": [
      "f",
      "rip",
      "triste"
    ]
  },
  "fr": {
    "funny": [
      "mdr",
      "ptdr",
      "xptdr",
      "jpp",
      "hahaha"
    ],
    "shock": [
      "quoi",
      "hein",
      "wesh",
      "cest pas possible",
      "c'est pas possible",
      "oh la"
    ],
    "hype": [
      "allez",
      "trop fort",
      "incroyable",
      "enorme",
      "énorme"
    ],
    "sad": [
      "f",
      "rip",
      "dommage",
      "triste"
    ]
  },
  "de": {
    "funny": [
      "haha",
      "hahaha",
      "lol",
      "xd"
    ],
    "shock": [
      "was",
      "krass",
      "alter",
      "digga",
      "wie bitte"
    ],
    "hype": [
      "geil",
      "los gehts",
      "stark",
      "ehrenmann"
    ],
    "sad": [
      "f",
      "rip",
      "schade",
      "traurig"
    ]
  },
  "it": {
    "funny": [
      "ahah",
      "ahahah",
      "ahahahah",
      "xd"
    ],
    "shock": [
      "cosa",
      "ma che",
      "non ci credo",
      "assurdo"
    ],
    "hype": [
      "forza",
      "dai",
      "grande",
      "fortissimo"
    ],
    "sad": [
      "f",
      "rip",
      "peccato",
      "triste"
    ]
  },
  "ar": {
    "funny": [
      "هههه",
      "ههههه",
      "ههه",
      "اضحك"
    ],
    "shock": [
      "ايش",
      "شنو",
      "والله",
      "مستحيل",
      "يا الله"
    ],
    "hype": [
      "يلا",
      "كفو",
      "اسطورة",
      "وحش"
    ],
    "sad": [
      "للاسف",
      "حرام",
      "rip"
    ]
  },
  "tr": {
    "funny": [
      "sjsjsj",
      "ahahah",
      "kdkdkd",
      "asdfgh"
    ],
    "shock": [
      "ne",
      "nasil",
      "nasıl",
      "inanmiyorum",
      "inanmıyorum",
      "oha"
    ],
    "hype": [
      "hadi",
      "helal",
      "efsane",
      "kral"
    ],
    "sad": [
      "f",
      "rip",
      "yazik",
      "yazık"
    ]
  }
};

export const CLIP_PHRASES: readonly string[] = ["clip", "clip it", "clip that", "clipped", "clip this", "clippen", "clipa", "clipalo", "cl\u00edpalo", "clipea", "clipper", "clippe", "klip", "clipe", "clipei"];

export const EMOTE_CATEGORIES: Record<string, string> = {
  "kekw": "funny",
  "lul": "funny",
  "lulw": "funny",
  "omegalul": "funny",
  "kekl": "funny",
  "icant": "funny",
  "lmao": "funny",
  "pepelaugh": "funny",
  "4head": "funny",
  "kappa": "funny",
  "emotelaugh": "funny",
  "emojilaughing": "funny",
  "monkas": "shock",
  "wutface": "shock",
  "dansgame": "shock",
  "notlikethis": "shock",
  "kreygasm": "shock",
  "pogo": "shock",
  "modcheck": "shock",
  "aware": "shock",
  "emotesurprised": "shock",
  "emojishocked": "shock",
  "pogchamp": "hype",
  "pog": "hype",
  "poggers": "hype",
  "pogu": "hype",
  "letsgo": "hype",
  "ez": "hype",
  "clap": "hype",
  "catjam": "hype",
  "emotehype": "hype",
  "emojifire": "hype",
  "gigachad": "hype",
  "biblethump": "sad",
  "sadge": "sad",
  "pepehands": "sad",
  "feelsbadman": "sad",
  "prayge": "sad",
  "emotesad": "sad",
  "emojicrying": "sad"
};

export const KNOWN_BOTS: ReadonlySet<string> = new Set(["botrixoficial", "commanderroot", "fossabot", "kickbot", "kofistreambot", "moobot", "nightbot", "pokemoncommunitygame", "sery_bot", "soundalerts", "streamelements", "streamlabs", "streamstickers", "wizebot"]);
