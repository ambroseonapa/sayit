// Speech-to-text (Whisper) and grammar fixing. Runs in the main process (Node), so no browser limits.
const S = require("./shared.js");

const WHISPER = {
  groq: { url: "https://api.groq.com/openai/v1/audio/transcriptions", models: ["whisper-large-v3-turbo", "whisper-large-v3"] },
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", models: ["gpt-4o-mini-transcribe", "whisper-1"] }
};

function withTimeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function errText(r) {
  if (r.status === 401 || r.status === 403) return "the API key was rejected";
  if (r.status === 429) return "free limit reached, wait a minute";
  let detail = "";
  try { const j = await r.json(); detail = (j.error && (j.error.message || j.error)) || ""; } catch {}
  return "error " + r.status + (detail ? ": " + String(detail).slice(0, 140) : "");
}

function vocabList(s) {
  return (s.vocab || "").split(/[,\n]+/).map((w) => w.trim()).filter(Boolean);
}

// ---------- Whisper ----------
const workingModel = {}; // remember which model worked, so we don't retry dead ones
async function transcribe(wav, s, prompt) {
  const keys = s.keys || {};
  const which = keys.groq ? "groq" : keys.openai ? "openai" : keys.gemini ? "gemini" : null;
  if (!which) throw new Error("Add a Groq key in SayIt settings (it's free). Claude can't listen to audio");
  if (which === "gemini") return transcribeGemini(wav, s, prompt);
  const models = workingModel[which] ? [workingModel[which]] : WHISPER[which].models;
  const vocab = vocabList(s);
  let lastErr;
  for (const model of models) {
    const fd = new FormData();
    fd.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    fd.append("model", model);
    fd.append("language", (s.lang || "en").split("-")[0]);
    fd.append("temperature", "0");
    fd.append("response_format", "json");
    const p = [vocab.length ? vocab.join(", ") + "." : "", prompt || ""].join(" ").trim().slice(-800);
    if (p) fd.append("prompt", p);
    let r;
    try {
      r = await fetch(WHISPER[which].url, { method: "POST", body: fd, headers: { authorization: "Bearer " + keys[which] }, signal: withTimeout(15000) });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "speech service took too long" : "couldn't reach the speech service, check your internet");
    }
    if (r.status === 404 || r.status === 400) { lastErr = await errText(r); continue; }
    if (!r.ok) throw new Error(await errText(r));
    workingModel[which] = model;
    const data = await r.json();
    return cleanWhisper(data.text || "");
  }
  throw new Error(lastErr || "speech service error");
}

// Gemini can also turn speech into text (slower than Groq, but works with only a Gemini key).
const GEMINI_AUDIO_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
async function transcribeGemini(wav, s, prompt) {
  const vocab = vocabList(s);
  const instr = "Transcribe this audio exactly as spoken, word for word, in " + ((s.lang || "en").startsWith("en") ? "English" : s.lang) +
    ". Add normal punctuation. Output only the words that were said, nothing else. If nobody speaks, output nothing." +
    (vocab.length ? " These names may appear: " + vocab.join(", ") + "." : "") +
    (prompt ? " For context, the speaker just said: \"" + prompt.slice(-200) + "\"" : "");
  const models = workingModel.gemini ? [workingModel.gemini] : GEMINI_AUDIO_MODELS;
  let lastErr;
  for (const model of models) {
    let r;
    try {
      r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
        method: "POST", signal: withTimeout(20000),
        headers: { "x-goog-api-key": s.keys.gemini, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: instr }, { inline_data: { mime_type: "audio/wav", data: Buffer.from(wav).toString("base64") } }] }],
          generationConfig: { temperature: 0 }
        })
      });
    } catch (e) { throw new Error(e.name === "AbortError" ? "speech service took too long" : "couldn't reach Google Gemini"); }
    if (r.status === 404 || r.status === 400) { lastErr = await errText(r); continue; }
    if (!r.ok) throw new Error(await errText(r));
    workingModel.gemini = model;
    const data = await r.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    return cleanWhisper(parts.map((p) => p.text || "").join(" "));
  }
  throw new Error(lastErr || "speech service error");
}

// Whisper sometimes "hears" these in silence or noise.
const FAKE = /^(thank(s| you)( so much)?( for watching| for listening)?[.!]?|you[.!]?|bye[.!]?|\.+|subtitles by.*|.*amara\.org.*)$/i;
function cleanWhisper(t) {
  t = t.trim();
  if (!t || FAKE.test(t)) return "";
  return t;
}

// ---------- grammar ----------
function aiConfig(s) {
  const p = S.SAYIT_PROVIDERS[s.provider];
  const key = (s.keys || {})[s.provider];
  if (!p || !key) return null;
  const url = s.provider === "custom" ? s.customUrl : p.url;
  const model = (s.models || {})[s.provider] || p.model;
  if (!url || !model) return null;
  return { provider: s.provider, url, model, key };
}


async function polish(text, s, mode) {
  mode = mode || s.mode;
  if (mode === "exact" || !text) return { text, changes: 0 };
  if (s.fillers) text = S.sayitRemoveFillers(text);
  const ai = aiConfig(s);
  if (!ai) return { text, changes: 0 }; // Whisper already punctuates; without an AI key we keep its text
  if (mode === "rephrase") {
    const out = await callAI(ai, S.sayitPrompt("rephrase", s), text);
    return { text: out, rephrased: true };
  }
  const out = await callAI(ai, S.sayitPrompt("grammar", s), text);
  const d = S.sayitWordsChanged(text, out);
  if (d.total >= 6 && d.ratio > 0.4) return { text, changes: 0, note: "The AI tried to change too much, so SayIt kept your words." };
  return { text: out, changes: d.changed };
}

async function callAI(ai, system, text) {
  try { return await callAIRaw(ai, system, text); }
  catch (e) {
    if (e.name === "AbortError") throw new Error("the grammar fixer took too long");
    if (e instanceof TypeError) throw new Error("couldn't reach " + (S.SAYIT_PROVIDERS[ai.provider] || {}).name);
    throw e;
  }
}

async function callAIRaw(ai, system, text) {
  const user = "<dictation>\n" + text + "\n</dictation>";
  const maxTokens = Math.min(4096, 200 + Math.ceil(text.length / 2));
  let r, out;
  if (ai.provider === "anthropic") {
    r = await fetch(ai.url, {
      method: "POST", signal: withTimeout(15000),
      headers: { "x-api-key": ai.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: ai.model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] })
    });
    if (!r.ok) throw new Error(await errText(r));
    const data = await r.json();
    out = (data.content || []).map((c) => c.text || "").join("");
  } else {
    const body = { model: ai.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    const reasoning = /^(gpt-5|o\d)/.test(ai.model);
    if (ai.provider === "openai") body.max_completion_tokens = maxTokens; else body.max_tokens = maxTokens;
    if (!reasoning) body.temperature = 0;
    if (/gpt-oss|qwen3|deepseek-r1/i.test(ai.model)) {
      if (ai.provider === "groq") { body.reasoning_effort = "low"; body.include_reasoning = false; }
      body.max_tokens = maxTokens + 1500;
    }
    r = await fetch(ai.url, {
      method: "POST", signal: withTimeout(15000),
      headers: { authorization: "Bearer " + ai.key, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(await errText(r));
    const data = await r.json();
    out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  }
  out = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
    .replace(/^<dictation>\s*/, "").replace(/\s*<\/dictation>$/, "").replace(/^"([\s\S]*)"$/, "$1").trim();
  if (!out) throw new Error("empty reply from the AI");
  return out;
}

const speechKey = (s) => !!(s.keys && (s.keys.groq || s.keys.openai || s.keys.gemini));
module.exports = { transcribe, polish, aiConfig, cleanWhisper, speechKey };
