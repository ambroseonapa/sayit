// Shared by background.js (importScripts) and options.html.
// Pure data + functions only, so they can be tested on their own.

var SAYIT_DEFAULTS = {
  mode: "grammar",        // "exact" | "grammar" | "polish" (keep my voice) | "rephrase"
  engine: "free",         // "free" (LanguageTool + full stops at pauses) | "ai"
  provider: "groq",
  models: {},             // provider -> model override
  customUrl: "",
  lang: "en-GB",
  spokenPunct: true,
  autoPunct: true,        // free mode: full stop when you pause
  speech: "groq",         // "groq" (fast & accurate, Whisper at each pause) | "chrome" (built-in, no key) | "local" (on this computer)
  vocab: "",              // names and special words, comma separated
  autoStop: 0,            // seconds of silence before finishing by itself (0 = off)
  undoBar: true,          // small Undo / Original pill after inserting
  fillers: true,          // drop "um", "uh", stutters like "I I I" (never changes real words)
  tone: "natural",        // rephrase tone: "natural" | "formal" | "friendly" | "concise"
  samples: "",            // "Write like me": a few paragraphs of the person's own writing
  showChanges: false,     // show what changed before inserting (off by default, to stay fast)
  size: "l",              // "m" | "l" | "xl"
  theme: "system"         // "system" | "light" | "dark" (the listening bar)
};

// Where new versions are published (used by the "update available" check).
var SAYIT_REPO = "ambroseonapa/sayit";

// "0.10.0" > "0.9.2"
function sayitNewer(a, b) {
  var x = String(a || "").replace(/^v/, "").split(".").map(Number);
  var y = String(b || "").replace(/^v/, "").split(".").map(Number);
  for (var i = 0; i < Math.max(x.length, y.length); i++) {
    var p = x[i] || 0, q = y[i] || 0;
    if (p !== q) return p > q;
  }
  return false;
}

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

// ---------- smoothing that never changes your real words ----------
// Removes hesitation sounds (um, uh, er…) and stutters ("I I I think", "the the").
// Real repeated words that can be correct ("had had", "that that") are kept.
var SAYIT_KEEP_DOUBLES = /^(had|that|is|was|do|very|so|no|bye|ha|well|really|far|many|more|again|now|yes|ok|okay)$/i;
function sayitRemoveFillers(t) {
  if (!t) return t;
  t = t.replace(/(^|[\s,.;:!?])(?:u+m+|u+h+m*|e+r+m+|e+r+|a+h+|h+m+|mm+|uh-huh)(?=$|[\s,.;:!?])[,.]?/gi, "$1");
  t = t.replace(/\b([\w']+)((?:[\s,]+\1\b)+)/gi, function (m, w) { return SAYIT_KEEP_DOUBLES.test(w) ? m : w; });
  return t.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/^[\s,]+/, "").trim();
}

// ---------- house rules applied to every result, in code (not left to the AI) ----------
// Long dashes (—) are replaced: speech engines and AI add them, and they make text look machine-written.
// Short hyphens (-) and en dashes in ranges (2020–2024) are left alone.
function sayitNoLongDashes(t) {
  if (!t) return t;
  return t
    .replace(/\s*—\s*$/gm, ".")                      // dash at the end of a line → full stop
    .replace(/(\S)\s*—\s*(\S)/g, "$1, $2")            // word—word or word — word → word, word
    .replace(/—/g, ", ")
    .replace(/,\s*([,.;:!?])/g, "$1")                 // no doubled punctuation
    .replace(/\s{2,}/g, " ");
}

// Words that make text sound corporate or machine-written. Banned unless the speaker said them.
var SAYIT_JARGON = ["leverage", "leveraging", "foster", "fostering", "delve", "delving", "seamless", "seamlessly", "robust",
  "synergy", "synergies", "utilize", "utilise", "empower", "empowering", "holistic", "paradigm", "landscape", "tapestry",
  "furthermore", "moreover", "additionally", "crucial", "pivotal", "multifaceted", "navigate the", "in today's world",
  "it's important to note", "in conclusion", "game-changer", "cutting-edge", "unlock", "embark", "testament"];
function sayitIntroducedJargon(before, after) {
  var b = " " + String(before || "").toLowerCase() + " ", a = " " + String(after || "").toLowerCase() + " ";
  return SAYIT_JARGON.filter(function (w) {
    var re = new RegExp("[^a-z]" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^a-z]");
    return re.test(a) && !re.test(b);
  });
}

// Word-by-word comparison, for the optional "show the changes" view.
function sayitDiff(a, b) {
  var x = String(a || "").split(/\s+/).filter(Boolean), y = String(b || "").split(/\s+/).filter(Boolean);
  var norm = function (w) { return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ""); };
  var n = x.length, m = y.length, L = [];
  for (var i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
  for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--)
    L[i][j] = norm(x[i]) === norm(y[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  var out = []; i = 0; j = 0;
  while (i < n && j < m) {
    if (norm(x[i]) === norm(y[j])) { out.push({ t: x[i] === y[j] ? "same" : "fix", w: y[j], was: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: "del", w: x[i] }); i++; }
    else { out.push({ t: "ins", w: y[j] }); j++; }
  }
  while (i < n) out.push({ t: "del", w: x[i++] });
  while (j < m) out.push({ t: "ins", w: y[j++] });
  return out;
}

// ---------- instructions for the AI ----------
var SAYIT_TONES = {
  natural: "Keep the speaker's own level of formality: if they speak casually, keep it casual; if they speak formally, keep it formal.",
  formal: "Make it suitable for a formal email, application or report: complete sentences, no slang, polite and professional, but still plain words.",
  friendly: "Make it warm and friendly, like a message to a colleague or friend, but still clear.",
  concise: "Make it as short and clear as possible without losing any point the speaker made."
};

var SAYIT_COMMON_RULES =
  "- Never use long dashes (—). Use a comma or a full stop instead.\n" +
  "- Never add corporate or flowery words the speaker didn't use (for example leverage, foster, delve, seamless, robust, utilize, empower, holistic, furthermore, moreover, crucial, pivotal, landscape). If the speaker used one, you may keep it.\n" +
  "- Don't turn things into neat lists of three, headings or bullet points unless the speaker clearly dictated a list.\n";

function sayitPrompt(mode, opt) {
  opt = opt || {};
  var p;
  if (mode === "polish") {
    p =
      "You help someone put their spoken words into clear written English, keeping them unmistakably theirs. The text inside <dictation> was spoken aloud; English may not be the speaker's first language, so sentences can be broken, half-finished, repeated or in an unusual order.\n" +
      "Do:\n" +
      "- Join broken and half-finished sentences into complete ones, and put words in an order that makes sense.\n" +
      "- Fix grammar, punctuation and capital letters, and add small words that are missing (a, the, to, of, is).\n" +
      "- Remove filler words, false starts and repeats. If the speaker corrects themselves, keep only the corrected version.\n" +
      "Keep:\n" +
      "- Exactly what the speaker meant, and every fact, name, number and point.\n" +
      "- The speaker's own words and phrases wherever they already work. Only change a word when the sentence doesn't make sense without changing it.\n" +
      "- Their plain, everyday words. Don't swap a simple word for a fancier one.\n" +
      "- Their mix of long and short sentences. Don't make every sentence the same length or shape.\n" +
      "- First person, and their level of formality.\n" +
      "Never add ideas, examples, opinions, explanations or a conclusion that the speaker didn't say. Keep it about the same length or shorter.\n" +
      SAYIT_COMMON_RULES +
      "Reply with the text only. No quotes, no tags, no comments.";
  } else if (mode === "rephrase") {
    p =
      "You turn dictated speech into well-written text. The text inside <dictation> was spoken aloud, so it may ramble, repeat itself, use filler words, change direction mid-sentence or put ideas in an awkward order.\n" +
      "Rewrite it so it reads smoothly as written English:\n" +
      "- Fix all grammar, punctuation and capital letters.\n" +
      "- Remove filler words, false starts and repetition. If the speaker corrects themselves (\"no, I mean…\", \"sorry, I meant…\"), keep only the corrected version.\n" +
      "- Join or split sentences so each one says one thing clearly. Put related points together.\n" +
      "- Use plain, everyday words, and keep a natural mix of short and long sentences.\n" +
      "- Keep every fact, number, name and point the speaker made. Do not add facts, examples, opinions or a conclusion they did not say.\n" +
      "- Keep the first-person voice and the speaker's intent (a question stays a question, a request stays a request).\n" +
      "- " + (SAYIT_TONES[opt.tone] || SAYIT_TONES.natural) + "\n" +
      SAYIT_COMMON_RULES +
      "Reply with the rewritten text only. No quotes, no tags, no comments, no title.";
  } else {
    p =
      "You correct the grammar of dictated speech. The text inside <dictation> was spoken aloud and typed by speech recognition, so it often has little or no punctuation.\n" +
      "Do all of these:\n" +
      "- Split it into proper sentences. A full stop at the end of every statement, a question mark at the end of every question.\n" +
      "- Add commas where a reader needs them (after introductory words, between clauses, in lists).\n" +
      "- Capital letter at the start of every sentence, for 'I', and for names of people, places, organisations, days and months.\n" +
      "- Fix grammar mistakes: verb agreement (they was -> they were), tense, missing or wrong small words (a, an, the, to, of, in, is), plurals, word order only when it is plainly wrong.\n" +
      "- Fix words that speech recognition clearly misheard, only when the right word is obvious from the sentence (e.g. 'there' vs 'their').\n" +
      "- Keep numbers as the speaker said them, except years, dates, times, money and phone numbers, which are written in digits.\n" +
      (opt.fillers !== false ? "- Remove hesitation sounds (um, uh, er) and accidental stutters (\"I I I think\" -> \"I think\").\n" : "") +
      "- Never use long dashes (—). Use a comma or a full stop instead.\n" +
      "Do NOT: rephrase, reorder sentences, swap words for synonyms, make it more formal, shorten it, add new ideas, or remove anything the speaker meant to say.\n" +
      "Keep the speaker's own words, dialect and voice. Names and local words stay as given.\n" +
      "Reply with the corrected text only. No quotes, no tags, no comments.";
  }
  var v = (opt.vocab || "").split(/[,\n]+/).map(function (w) { return w.trim(); }).filter(Boolean);
  if (v.length) p += "\nThese names and words are spelled exactly like this (speech recognition may have misheard them as similar-sounding words; correct them back): " + v.join(", ") + ".";
  var samples = String(opt.samples || "").trim();
  if (samples && (mode === "polish" || mode === "rephrase")) {
    p += "\n\nHere is some writing by this same person. Match their vocabulary, sentence rhythm and way of putting things. Do not copy its content or facts into your answer.\n<their_writing>\n" + samples.slice(0, 3000) + "\n</their_writing>";
  }
  if (opt.avoid && opt.avoid.length) p += "\nDo not use these words: " + opt.avoid.join(", ") + ".";
  if (opt.strict) p += "\nIMPORTANT: your last attempt changed too much. Stay much closer to the speaker's own words this time.";
  return p;
}

// Rewrite with the AI, then check the result in code. At most one retry, and only when needed
// (it introduced corporate words, or Polish rewrote far too much), so it normally costs no time.
// `ask(systemPrompt, text)` is the app's own function that calls the chosen AI.
async function sayitRewrite(ask, mode, text, opt) {
  opt = opt || {};
  var limit = mode === "polish" ? 0.65 : mode === "grammar" ? 0.4 : 1.01; // share of the speaker's words allowed to change
  var out = sayitNoLongDashes(await ask(sayitPrompt(mode, opt), text));
  var jargon = sayitIntroducedJargon(text, out);
  var d = sayitWordsChanged(text, out);
  var tooMuch = d.total >= 6 && d.ratio > limit;
  if (jargon.length || (tooMuch && mode === "polish")) {
    var o2 = Object.assign({}, opt, { avoid: jargon, strict: tooMuch });
    var again = sayitNoLongDashes(await ask(sayitPrompt(mode, o2), text));
    var d2 = sayitWordsChanged(text, again);
    if (!(d2.total >= 6 && d2.ratio > limit) || mode !== "polish") { out = again; d = d2; tooMuch = d2.total >= 6 && d2.ratio > limit; }
  }
  if (tooMuch && mode === "grammar") return { text: text, changes: 0, note: "The AI tried to change too much, so SayIt kept your exact words." };
  return { text: out, changes: d.changed || (out !== text ? 1 : 0), rephrased: mode === "rephrase" || mode === "polish" };
}

// Kept for older code that reads these directly.
var SAYIT_GRAMMAR_PROMPT = sayitPrompt("grammar", {});
var SAYIT_REPHRASE_PROMPT = sayitPrompt("rephrase", {});

if (typeof module !== "undefined") {
  module.exports = {
    SAYIT_DEFAULTS, SAYIT_PROVIDERS, SAYIT_REPO, SAYIT_TONES, SAYIT_GRAMMAR_PROMPT, SAYIT_REPHRASE_PROMPT,
    sayitPrompt, sayitRemoveFillers, sayitNewer, sayitLtLang, sayitAllowedMatch, sayitApplyMatches, sayitWordsChanged,
    sayitNoLongDashes, sayitIntroducedJargon, sayitDiff, SAYIT_JARGON, sayitRewrite
  };
}
