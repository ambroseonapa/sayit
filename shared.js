// Shared by background.js (importScripts) and options.html.
// Pure data + functions only, so they can be tested on their own.

var SAYIT_DEFAULTS = {
  mode: "grammar",        // "exact" | "grammar" | "rephrase"
  engine: "free",         // "free" (LanguageTool + full stops at pauses) | "ai"
  provider: "groq",
  models: {},             // provider -> model override
  customUrl: "",
  lang: "en-GB",
  spokenPunct: true,
  autoPunct: true,        // free mode: full stop when you pause
  speech: "chrome",       // "chrome" (instant) | "whisper" (most accurate) | "local" (on this computer)
  vocab: "",              // names and special words, comma separated
  autoStop: 0,            // seconds of silence before finishing by itself (0 = off)
  undoBar: true,          // small Undo / Original pill after inserting
  size: "l"               // "m" | "l" | "xl"
};

// Every provider except Anthropic speaks the OpenAI "chat completions" format.
var SAYIT_PROVIDERS = {
  groq: {
    name: "Groq", note: "Free key, fastest. Recommended.",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-20b", keyUrl: "https://console.groq.com/keys"
  },
  gemini: {
    name: "Google Gemini", note: "Free key from Google AI Studio.",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.1-flash-lite", keyUrl: "https://aistudio.google.com/apikey"
  },
  openai: {
    name: "OpenAI (ChatGPT)", note: "Paid.",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini", keyUrl: "https://platform.openai.com/api-keys"
  },
  anthropic: {
    name: "Anthropic (Claude)", note: "Paid.",
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-haiku-4-5-20251001", keyUrl: "https://console.anthropic.com/settings/keys"
  },
  openrouter: {
    name: "OpenRouter", note: "One key for hundreds of models.",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "google/gemini-2.5-flash-lite", keyUrl: "https://openrouter.ai/keys"
  },
  custom: {
    name: "Other (OpenAI-compatible)", note: "Any service with an OpenAI-style /chat/completions address.",
    url: "", model: "", keyUrl: ""
  }
};

// Speech language -> LanguageTool language (null = no free grammar check)
function sayitLtLang(lang) {
  var map = {
    "en-GB": "en-GB", "en-US": "en-US", "en-ZA": "en-ZA", "en-AU": "en-AU",
    "en-KE": "en-GB", "en-NG": "en-GB", "en-IN": "en-GB", "en-TZ": "en-GB",
    "fr-FR": "fr", "es-ES": "es", "pt-PT": "pt-PT", "de-DE": "de-DE"
  };
  return map[lang] || null;
}

// Which LanguageTool findings we apply: grammar, punctuation, capitals, wrong-word confusions.
// Never style/wordiness suggestions (they change how you say things), and never spelling:
// speech recognition only outputs real words, so a "misspelling" is almost always a name
// (Okidi, Oyam, Makerere) and "fixing" it would break it.
var SAYIT_ALLOWED_CATEGORIES = [
  "GRAMMAR", "PUNCTUATION", "CASING", "TYPOGRAPHY",
  "CONFUSED_WORDS", "COMPOUNDING", "TYPOS"
];

function sayitAllowedMatch(m) {
  if (!m || !m.replacements || !m.replacements.length) return false;
  var rule = m.rule || {};
  var cat = (rule.category && rule.category.id) || "";
  var type = rule.issueType || "";
  var id = rule.id || "";
  if (type === "misspelling" || /MORFOLOGIK|SPELLER|HUNSPELL/i.test(id)) return false;
  if (type === "style" || type === "register") return false;
  return SAYIT_ALLOWED_CATEGORIES.indexOf(cat) !== -1;
}

function sayitApplyMatches(text, matches) {
  var keep = (matches || []).filter(sayitAllowedMatch)
    .sort(function (a, b) { return b.offset - a.offset; });
  var out = text, n = 0, lastStart = Infinity;
  for (var i = 0; i < keep.length; i++) {
    var m = keep[i];
    if (m.offset + m.length > lastStart) continue; // overlapping, skip
    out = out.slice(0, m.offset) + m.replacements[0].value + out.slice(m.offset + m.length);
    lastStart = m.offset;
    n++;
  }
  return { text: out, changes: n };
}

// Word-level difference: how many of the original words did NOT survive, in order.
function sayitWordsChanged(a, b) {
  var norm = function (s) {
    return s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
  };
  var x = norm(a), y = norm(b);
  if (!x.length) return { changed: y.length, total: 0, ratio: y.length ? 1 : 0 };
  var prev = new Array(y.length + 1).fill(0);
  for (var i = 1; i <= x.length; i++) {
    var cur = [0];
    for (var j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  var lcs = prev[y.length];
  var changed = Math.max(x.length, y.length) - lcs;
  return { changed: changed, total: x.length, ratio: changed / x.length };
}

var SAYIT_GRAMMAR_PROMPT =
  "You correct the grammar of dictated speech. The text inside <dictation> was spoken aloud and typed by speech recognition, so it often has no punctuation at all.\n" +
  "Do all of these:\n" +
  "- Split it into proper sentences. Put a full stop at the end of every statement, a question mark at the end of every question.\n" +
  "- Add commas where they are needed.\n" +
  "- Capital letter at the start of every sentence, for 'I', and for names of people, places and organisations.\n" +
  "- Fix grammar mistakes: verb agreement (they was -> they were), tense, missing or wrong small words (a, an, the, to, of, is), plurals.\n" +
  "- Fix words that speech recognition clearly misheard, only when the right word is obvious from the sentence.\n" +
  "Do NOT: rephrase, reorder, swap words for synonyms, make it more formal, shorten it, add new ideas, or remove anything the speaker said.\n" +
  "Keep the speaker's own words and voice. Names and local words stay as given.\n" +
  "Reply with the corrected text only. No quotes, no tags, no comments.";

var SAYIT_REPHRASE_PROMPT =
  "You tidy up dictated speech. The text inside <dictation> was spoken aloud. Rewrite it so it reads clearly as written English, with correct grammar and punctuation.\n" +
  "Keep the same meaning, the same facts and the first-person voice. Do not add facts, examples or claims the speaker did not make.\n" +
  "Use plain, simple words. Keep names and local words exactly as given. Keep roughly the same length.\n" +
  "Reply with the rewritten text only. No quotes, no tags, no comments.";

if (typeof module !== "undefined") {
  module.exports = { SAYIT_DEFAULTS, SAYIT_PROVIDERS, sayitLtLang, sayitAllowedMatch, sayitApplyMatches, sayitWordsChanged };
}
