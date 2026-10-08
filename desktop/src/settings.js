const api = window.sayit;
const $ = (id) => document.getElementById(id);
let S = {}, savedTimer;
const isMac = api.platform === "darwin";

function flash() { $("saved").classList.add("on"); clearTimeout(savedTimer); savedTimer = setTimeout(() => $("saved").classList.remove("on"), 1100); }
async function set(patch) { const r = await api.setSettings(patch); flash(); return r; }
const pretty = (k) => (isMac ? k.replace(/Alt/g, "Option").replace(/CommandOrControl|Command/g, "Cmd").replace(/Control/g, "Ctrl") : k.replace(/Control/g, "Ctrl"));

function showProvider() {
  const p = SAYIT_PROVIDERS[S.provider] || SAYIT_PROVIDERS.groq;
  $("provider").value = S.provider;
  $("otherKeyBox").style.display = S.provider === "groq" ? "none" : "";
  $("otherKey").value = (S.keys || {})[S.provider] || "";
  $("customBox").style.display = S.provider === "custom" ? "" : "none";
  $("customUrl").value = S.customUrl || "";
  $("model").value = (S.models || {})[S.provider] || "";
  $("model").placeholder = p.model || "model name";
}

async function load() {
  S = await api.getFullSettings();
  for (const [id, p] of Object.entries(SAYIT_PROVIDERS)) {
    const o = document.createElement("option"); o.value = id; o.textContent = p.name + (id === "groq" ? " (uses the key above)" : ""); $("provider").appendChild(o);
  }
  $("groqKey").value = (S.keys || {}).groq || "";
  document.querySelector(`input[name=mode][value=${S.mode}]`).checked = true;
  $("lang").value = ["en-GB", "sw-KE", "fr-FR", "es-ES", "pt-PT", "de-DE"].includes(S.lang) ? S.lang : "en-GB";
  $("vocab").value = S.vocab || "";
  $("hotkey").value = pretty(S.hotkey);
  $("hk1").textContent = pretty(S.hotkey);
  $("showBubble").checked = S.showBubble;
  $("fillers").checked = S.fillers !== false;
  $("tone").value = S.tone || "natural";
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

function saveGroqKey() { const v = $("groqKey").value.trim(); if ((S.keys || {}).groq === v) return; S.keys = { ...S.keys, groq: v }; set({ keys: { groq: v } }); }
$("groqKey").addEventListener("input", saveGroqKey);
$("groqKey").addEventListener("change", saveGroqKey);
document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => set({ mode: r.value })));
$("lang").addEventListener("change", () => set({ lang: $("lang").value }));
$("vocab").addEventListener("change", () => set({ vocab: $("vocab").value.trim() }));
$("showBubble").addEventListener("change", () => set({ showBubble: $("showBubble").checked }));
$("fillers").addEventListener("change", () => set({ fillers: $("fillers").checked }));
$("tone").addEventListener("change", () => set({ tone: $("tone").value }));
document.querySelectorAll("input[name=bubbleSize]").forEach((r) => r.addEventListener("change", () => set({ bubbleSize: r.value })));
for (const name of ["theme", "panelPlace", "textSize"]) document.querySelectorAll(`input[name=${name}]`).forEach((r) => r.addEventListener("change", () => set({ [name]: r.value })));
$("resetPanel").addEventListener("click", async () => { await api.resetPanel(); $("resetPanel").textContent = "Box size reset ✓"; });
function showUpdate(u) {
  if (!u) { $("updateBox").hidden = true; return false; }
  $("newVer").textContent = "v" + u.version;
  $("newLink").onclick = () => api.openUrl(u.url);
  $("updateBox").hidden = false;
  return true;
}
api.on("update", showUpdate);
$("checkUpd").addEventListener("click", async () => {
  $("checkUpd").textContent = "Checking…";
  const r = await api.checkUpdate();
  $("checkUpd").textContent = r.error ? r.error : showUpdate(r.update) ? "New version found ↑" : "You have the latest version ✓";
});
$("provider").addEventListener("change", () => { if (S.provider !== "groq") saveOtherKey(); S.provider = $("provider").value; set({ provider: S.provider }); showProvider(); });
function saveOtherKey() { const v = $("otherKey").value.trim(); if ((S.keys || {})[S.provider] === v) return; S.keys = { ...S.keys, [S.provider]: v }; set({ keys: { [S.provider]: v } }); }
$("otherKey").addEventListener("input", saveOtherKey);
$("otherKey").addEventListener("change", saveOtherKey);
$("customUrl").addEventListener("change", () => set({ customUrl: $("customUrl").value.trim() }));
$("model").addEventListener("change", () => set({ models: { [S.provider]: $("model").value.trim() } }));
document.querySelectorAll("a[data-url]").forEach((a) => a.addEventListener("click", () => api.openUrl(a.dataset.url)));

$("testAi").addEventListener("click", async () => {
  const st = $("aiStatus");
  if (!$("groqKey").value.trim() && !(S.keys || {})[S.provider]) { st.textContent = "Paste your key first."; st.className = "status bad"; return; }
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
