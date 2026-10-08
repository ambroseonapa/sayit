const api = window.sayit;
const $ = (id) => document.getElementById(id);
let S = {}, savedTimer;
const isMac = api.platform === "darwin";

function flash() { $("saved").classList.add("on"); clearTimeout(savedTimer); savedTimer = setTimeout(() => $("saved").classList.remove("on"), 1100); }
async function set(patch) { const r = await api.setSettings(patch); flash(); return r; }
const pretty = (k) => (isMac ? k.replace(/Alt/g, "Option").replace(/CommandOrControl|Command/g, "Cmd").replace(/Control/g, "Ctrl") : k.replace(/Control/g, "Ctrl"));

// Speech (voice → text) needs Groq, OpenAI or Gemini; Claude and others only fix the words.
const SPEECH = { groq: "Groq", openai: "OpenAI", gemini: "Gemini" };
function showSpeechInfo() {
  const k = S.keys || {};
  const have = Object.keys(SPEECH).filter((id) => k[id]);
  const el = $("speechInfo");
  if (have.length) {
    el.innerHTML = "";
    el.append("✓ Your voice is turned into text with your " + SPEECH[have[0]] + " key. " +
      (S.provider in SPEECH ? "" : (SAYIT_PROVIDERS[S.provider] || {}).name + " fixes the words."));
    el.className = "small good";
  } else {
    el.textContent = "⚠ To turn your voice into text, SayIt also needs a Groq (free), OpenAI or Gemini key. " +
      (S.provider in SPEECH ? "Paste it above." : (SAYIT_PROVIDERS[S.provider] || {}).name + " can fix the words but can't listen. Choose Groq above, paste a free Groq key, then switch back. SayIt keeps both keys.");
    el.className = "small bad";
  }
}
function showProvider() {
  const p = SAYIT_PROVIDERS[S.provider] || SAYIT_PROVIDERS.groq;
  $("provider").value = S.provider;
  $("provName").textContent = p.name;
  $("aiKey").value = (S.keys || {})[S.provider] || "";
  showSpeechInfo();
  $("customBox").style.display = S.provider === "custom" ? "" : "none";
  $("customUrl").value = S.customUrl || "";
  $("model").value = (S.models || {})[S.provider] || "";
  $("model").placeholder = p.model || "model name";
}

async function load() {
  S = await api.getFullSettings();
  for (const [id, p] of Object.entries(SAYIT_PROVIDERS)) {
    const o = document.createElement("option"); o.value = id; o.textContent = p.name + (id === "groq" ? " (free, fastest)" : id === "gemini" ? " (free)" : ""); $("provider").appendChild(o);
  }
  document.querySelector(`input[name=mode][value=${S.mode}]`).checked = true;
  $("lang").value = ["en-GB", "sw-KE", "fr-FR", "es-ES", "pt-PT", "de-DE"].includes(S.lang) ? S.lang : "en-GB";
  $("vocab").value = S.vocab || "";
  $("hotkey").value = pretty(S.hotkey);
  $("hk1").textContent = pretty(S.hotkey);
  $("showBubble").checked = S.showBubble;
  $("fillers").checked = S.fillers !== false;
  $("tone").value = S.tone || "natural";
  $("samples").value = S.samples || "";
  $("showChanges").checked = !!S.showChanges;
  document.querySelector(`input[name=bubbleSize][value=${S.bubbleSize || "m"}]`).checked = true;
  for (const [name, def] of [["theme", "system"], ["panelPlace", "typing"], ["textSize", "l"]]) {
    const r = document.querySelector(`input[name=${name}][value=${S[name] || def}]`); if (r) r.checked = true;
  }
  const u = await api.getUpdate();
  $("ver").textContent = "v" + u.current;
  showUpdate(u.update);
  $("trayName").textContent = isMac ? "menu bar (top of the screen)" : "system tray (bottom-right, near the clock)";
  showProvider();
}

document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => set({ mode: r.value })));
$("lang").addEventListener("change", () => set({ lang: $("lang").value }));
$("vocab").addEventListener("change", () => set({ vocab: $("vocab").value.trim() }));
$("showBubble").addEventListener("change", () => set({ showBubble: $("showBubble").checked }));
$("fillers").addEventListener("change", () => set({ fillers: $("fillers").checked }));
$("tone").addEventListener("change", () => set({ tone: $("tone").value }));
$("samples").addEventListener("change", () => set({ samples: $("samples").value.trim().slice(0, 3000) }));
$("showChanges").addEventListener("change", () => set({ showChanges: $("showChanges").checked }));
document.querySelectorAll("input[name=bubbleSize]").forEach((r) => r.addEventListener("change", () => set({ bubbleSize: r.value })));
for (const name of ["theme", "panelPlace", "textSize"]) document.querySelectorAll(`input[name=${name}]`).forEach((r) => r.addEventListener("change", () => set({ [name]: r.value })));
$("resetPanel").addEventListener("click", async () => { await api.resetPanel(); $("resetPanel").textContent = "Box size reset ✓"; });
function showUpdate(u) {
  if (!u) { $("updateBox").hidden = true; return false; }
  $("newVer").textContent = "v" + u.version;
  $("newLink").onclick = () => api.openUrl(u.url);
  $("updNow").hidden = !u.auto;
  $("updHow").textContent = u.auto
    ? "Press Update now. SayIt downloads it, installs it and opens again by itself. Your keys and settings stay."
    : "Download it and install it over this one. Your keys and settings stay.";
  if (!u.auto) $("newLink").textContent = "Download the new version →";
  $("updateBox").hidden = false;
  return true;
}
api.on("update", showUpdate);
$("updNow").addEventListener("click", async () => {
  $("updNow").disabled = true; $("updBar").hidden = false; $("updMsg").textContent = "Starting…";
  const r = await api.installUpdate();
  if (r && r.error) { $("updMsg").textContent = r.error; $("updNow").disabled = false; $("updBar").hidden = true; }
  else if (r && r.opened) { $("updMsg").textContent = "The download page is open in your browser."; $("updNow").disabled = false; }
});
api.on("update-progress", ({ f, msg }) => { $("updFill").style.width = Math.round(f * 100) + "%"; $("updMsg").textContent = msg; });
$("checkUpd").addEventListener("click", async () => {
  $("checkUpd").textContent = "Checking…";
  const r = await api.checkUpdate();
  const found = !r.error && showUpdate(r.update);
  $("checkUpd").textContent = r.error ? r.error : found ? "New version found ↓"
    : "You have the latest version (v" + r.current + ") ✓";
  if (found) { // show the update right here, next to the button you pressed
    const box = $("updateBox"), foot = document.querySelector(".foot");
    foot.parentNode.insertBefore(box, foot);
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});
$("provider").addEventListener("change", () => { saveKey(); S.provider = $("provider").value; set({ provider: S.provider }); showProvider(); $("aiStatus").textContent = ""; });
function saveKey() { const v = $("aiKey").value.trim(); if (((S.keys || {})[S.provider] || "") === v) return; S.keys = { ...S.keys, [S.provider]: v }; set({ keys: { [S.provider]: v } }); showSpeechInfo(); }
$("aiKey").addEventListener("input", saveKey);
$("aiKey").addEventListener("change", saveKey);
$("customUrl").addEventListener("change", () => set({ customUrl: $("customUrl").value.trim() }));
$("model").addEventListener("change", () => set({ models: { [S.provider]: $("model").value.trim() } }));
document.querySelectorAll("a[data-url]").forEach((a) => a.addEventListener("click", () => api.openUrl(a.dataset.url)));

$("testAi").addEventListener("click", async () => {
  const st = $("aiStatus");
  if (!(S.keys || {})[S.provider]) { st.textContent = "Paste your key first."; st.className = "status bad"; return; }
  st.textContent = "Testing…"; st.className = "status";
  const r = await api.testAI();
  if (r.error) { st.textContent = "✗ " + r.error; st.className = "status bad"; return; }
  st.textContent = `✓ Works. ${(r.ms / 1000).toFixed(1)} s → "${r.text}"`; st.className = "status good";
});

// ----- pick a shortcut by pressing it -----
$("hotkey").addEventListener("focus", () => { $("hotkey").classList.add("rec"); $("hotkey").value = "Press keys…"; });
$("hotkey").addEventListener("blur", () => { $("hotkey").classList.remove("rec"); $("hotkey").value = pretty(S.hotkey); });
$("hotkey").addEventListener("keydown", async (e) => {
  e.preventDefault();
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
  if (e.key === "Escape") { $("hotkey").blur(); return; }
  const mods = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.metaKey) mods.push("Command");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (!mods.length) { $("hkMsg").textContent = "Use at least one of Ctrl, Alt, Shift" + (isMac ? ", Cmd" : "") + "."; return; }
  let key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.code === "Space" ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const acc = [...mods, key].join("+");
  const r = await set({ hotkey: acc });
  if (r.hotkeyOk) { S.hotkey = acc; $("hkMsg").textContent = "✓ Saved. Another app can't be using the same keys."; $("hk1").textContent = pretty(acc); }
  else $("hkMsg").textContent = "✗ Another app already uses " + pretty(acc) + ". Try a different one.";
  $("hotkey").blur();
});

load();
