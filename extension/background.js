importScripts("shared.js");

// ---------- Toolbar click / Alt+Shift+S ----------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.__sayit && window.__sayit.toggle()
    });
  } catch (e) {
    chrome.action.setBadgeBackgroundColor({ color: "#b3261e", tabId: tab.id });
    chrome.action.setBadgeText({ text: "×", tabId: tab.id });
    chrome.action.setTitle({ tabId: tab.id, title: "SayIt can't run on this page (browser pages and the Web Store are locked)." });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 3000);
  }
});

// ---------- "new version available" check (once a day, GitHub releases) ----------
async function checkUpdate(force) {
  const { lastCheck = 0 } = await chrome.storage.local.get("lastCheck");
  if (!force && Date.now() - lastCheck < 20 * 3600 * 1000) return;
  await chrome.storage.local.set({ lastCheck: Date.now() });
  try {
    const r = await fetch(`https://api.github.com/repos/${SAYIT_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) return;
    const rel = await r.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const mine = chrome.runtime.getManifest().version;
    if (latest && sayitNewer(latest, mine)) {
      await chrome.storage.local.set({ update: { version: latest, url: rel.html_url } });
      chrome.action.setBadgeBackgroundColor({ color: "#1f7a3f" });
      chrome.action.setBadgeText({ text: "new" });
      chrome.action.setTitle({ title: `SayIt: version ${latest} is available. Open SayIt settings to update.` });
    } else {
      await chrome.storage.local.remove("update");
      chrome.action.setBadgeText({ text: "" });
    }
  } catch {}
}
chrome.runtime.onStartup.addListener(() => checkUpdate(false));
chrome.alarms && chrome.alarms.create("sayit-update", { periodInMinutes: 24 * 60 });
chrome.alarms && chrome.alarms.onAlarm.addListener((a) => a.name === "sayit-update" && checkUpdate(false));

chrome.runtime.onInstalled.addListener(async (d) => {
  checkUpdate(true);
  // Move settings from version 0.1
  const old = await chrome.storage.sync.get(["engine"]);
  if (old.engine === "languagetool") await chrome.storage.sync.set({ engine: "free" });
  if (old.engine === "claude") await chrome.storage.sync.set({ engine: "ai", provider: "anthropic" });
  const { apiKey, keys } = await chrome.storage.local.get(["apiKey", "keys"]);
  if (apiKey && !(keys && keys.anthropic)) {
    await chrome.storage.local.set({ keys: { ...(keys || {}), anthropic: apiKey } });
    await chrome.storage.local.remove("apiKey");
  }
  if (d.reason === "install") chrome.runtime.openOptionsPage();
});

// ---------- Messages ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "polish") {
    const t0 = Date.now();
    polish(msg.text, msg.mode)
      .then((r) => reply({ ...r, ms: Date.now() - t0 }), (err) => reply({ error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.type === "transcribe") {
    const t0 = Date.now();
    transcribe(msg).then((r) => reply({ ...r, ms: Date.now() - t0 }), (err) => reply({ error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.type === "warm") { warm(); }
  if (msg && msg.type === "openOptions") chrome.runtime.openOptionsPage();
  if (msg && msg.type === "checkUpdate") { checkUpdate(true).then(() => chrome.storage.local.get("update")).then((u) => reply(u.update || null)); return true; }
});

async function getSettings() {
  const sync = await chrome.storage.sync.get(SAYIT_DEFAULTS);
  const { keys } = await chrome.storage.local.get({ keys: {} });
  return { ...sync, keys };
}


function aiConfig(s) {
  const p = SAYIT_PROVIDERS[s.provider];
  const key = (s.keys || {})[s.provider];
  if (!p || !key) return null;
  const url = s.provider === "custom" ? s.customUrl : p.url;
  const model = (s.models || {})[s.provider] || p.model;
  if (!url || !model) return null;
  return { provider: s.provider, url, model, key };
}

// Open the network connection early, so the first real request is quicker.
let warmed = 0;
async function warm() {
  if (Date.now() - warmed < 60000) return;
  warmed = Date.now();
  const s = await getSettings();
  const ai = s.engine === "ai" || s.mode === "rephrase" ? aiConfig(s) : null;
  const url = ai ? ai.url : "https://api.languagetool.org/v2/languages";
  fetch(url, { method: ai ? "OPTIONS" : "GET" }).catch(() => {});
}

async function polish(text, mode) {
  const s = await getSettings();
  mode = mode || s.mode;
  if (mode === "exact") return { text, changes: 0 };
  const ai = aiConfig(s);

  if (mode === "rephrase") {
    if (!ai) return { text, changes: 0, note: "Rephrase needs an AI key (SayIt settings). Inserted your exact words." };
    const out = await callAI(ai, sayitPrompt("rephrase", s), text);
    return { text: out, changes: sayitWordsChanged(text, out).changed, rephrased: true };
  }

  if (s.engine === "ai" && ai) {
    const out = await callAI(ai, sayitPrompt("grammar", s), text);
    const d = sayitWordsChanged(text, out);
    // Safety net: grammar mode must not rewrite you.
    if (d.total >= 6 && d.ratio > 0.4) {
      return { text, changes: 0, note: "The AI tried to change too much, so SayIt kept your exact words." };
    }
    return { text: out, changes: d.changed || (out !== text ? 1 : 0), ai: true };
  }
  return await languageTool(s.fillers ? sayitRemoveFillers(text) : text, s.lang);
}

function withTimeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function languageTool(text, lang) {
  const ltLang = sayitLtLang(lang);
  if (!ltLang) return { text, changes: 0 };
  const body = new URLSearchParams({ text, language: ltLang, level: "default" });
  let r;
  try { r = await fetch("https://api.languagetool.org/v2/check", { method: "POST", body, signal: withTimeout(6000) }); }
  catch (e) { throw new Error(e.name === "AbortError" ? "free checker took too long" : "couldn't reach the free checker. Check your internet"); }
  if (r.status === 429) throw new Error("free grammar service is busy, wait a minute");
  if (!r.ok) throw new Error("grammar service error " + r.status);
  const data = await r.json();
  return sayitApplyMatches(text, data.matches);
}

async function callAI(ai, system, text) {
  try { return await callAIRaw(ai, system, text); }
  catch (e) {
    if (e.name === "AbortError") throw new Error("the AI took too long");
    if (e instanceof TypeError) throw new Error("couldn't reach " + (SAYIT_PROVIDERS[ai.provider] || {}).name + ". Check your internet");
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
      headers: {
        "x-api-key": ai.key, "anthropic-version": "2023-06-01", "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true"
      },
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
      // "Thinking" models: think briefly, and leave room for the answer after the thinking.
      if (ai.provider === "groq") { body.reasoning_effort = "low"; body.include_reasoning = false; }
      body.max_tokens = maxTokens + 1500;
    }
    r = await fetch(ai.url, {
      method: "POST", signal: withTimeout(15000),
      headers: { "authorization": "Bearer " + ai.key, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(await errText(r));
    const data = await r.json();
    out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  }
  out = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
    .replace(/^<dictation>\s*/, "").replace(/\s*<\/dictation>$/, "")
    .replace(/^"([\s\S]*)"$/, "$1").trim();
  if (!out) throw new Error("empty reply from the AI");
  return out;
}

async function errText(r) {
  if (r.status === 401 || r.status === 403) return "the API key was rejected";
  if (r.status === 429) return "AI limit reached, wait a minute";
  let detail = "";
  try { const j = await r.json(); detail = (j.error && (j.error.message || j.error)) || ""; } catch {}
  return "AI error " + r.status + (detail ? ": " + String(detail).slice(0, 120) : "");
}

// ---------- Whisper: most accurate speech-to-text (Groq or OpenAI key) ----------
const WHISPER = {
  groq: { url: "https://api.groq.com/openai/v1/audio/transcriptions", models: ["whisper-large-v3-turbo", "whisper-large-v3"] },
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", models: ["gpt-4o-mini-transcribe", "whisper-1"] }
};

async function transcribe({ audio, mime, lang }) {
  const s = await getSettings();
  const keys = s.keys || {};
  const which = keys.groq ? "groq" : keys.openai ? "openai" : null;
  if (!which) throw new Error("Most accurate speech needs a Groq or OpenAI key");
  const bin = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
  const blob = new Blob([bin], { type: mime || "audio/webm" });
  const vocab = (s.vocab || "").split(/[,\n]+/).map((w) => w.trim()).filter(Boolean).join(", ");
  let lastErr;
  for (const model of WHISPER[which].models) {
    const fd = new FormData();
    fd.append("file", blob, "speech.webm");
    fd.append("model", model);
    fd.append("language", (lang || "en").split("-")[0]);
    fd.append("temperature", "0");
    fd.append("response_format", "json");
    if (vocab) fd.append("prompt", vocab + ".");
    let r;
    try {
      r = await fetch(WHISPER[which].url, { method: "POST", body: fd, headers: { authorization: "Bearer " + keys[which] }, signal: withTimeout(12000) });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "speech service took too long" : "couldn't reach the speech service");
    }
    if (r.status === 404 || r.status === 400) { lastErr = await errText(r); continue; } // model gone? try the next one
    if (!r.ok) throw new Error(await errText(r));
    const data = await r.json();
    return { text: (data.text || "").trim(), engine: which };
  }
  throw new Error(lastErr || "speech service error");
}
