const $ = (id) => document.getElementById(id);
let S = { ...SAYIT_DEFAULTS }, KEYS = {}, savedTimer;

function flash() {
  $("saved").classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("saved").classList.remove("on"), 1200);
}
const setSync = (o) => { Object.assign(S, o); return chrome.storage.sync.set(o).then(flash); };

function showProvider() {
  const p = SAYIT_PROVIDERS[S.provider] || SAYIT_PROVIDERS.groq;
  $("provider").value = S.provider;
  $("provNote").textContent = p.note;
  $("key").value = KEYS[S.provider] || "";
  $("model").value = (S.models || {})[S.provider] || "";
  $("model").placeholder = p.model || "model name";
  $("keyLink").style.display = p.keyUrl ? "" : "none";
  if (p.keyUrl) $("keyLink").href = p.keyUrl;
  $("customBox").style.display = S.provider === "custom" ? "" : "none";
  $("customUrl").value = S.customUrl || "";
  $("aiStatus").textContent = "";
}

async function load() {
  S = await chrome.storage.sync.get(SAYIT_DEFAULTS);
  KEYS = (await chrome.storage.local.get({ keys: {} })).keys;
  for (const [id, p] of Object.entries(SAYIT_PROVIDERS)) {
    const o = document.createElement("option"); o.value = id; o.textContent = p.name; $("provider").appendChild(o);
  }
  document.querySelector(`input[name=mode][value=${S.mode}]`).checked = true;
  document.querySelector(`input[name=engine][value=${S.engine}]`).checked = true;
  document.querySelector(`input[name=size][value=${S.size}]`).checked = true;
  $("lang").value = S.lang;
  $("spokenPunct").checked = S.spokenPunct;
  $("autoPunct").checked = S.autoPunct;
  $("undoBar").checked = S.undoBar;
  document.querySelector(`input[name=speech][value=${S.speech}]`).checked = true;
  $("vocab").value = S.vocab || "";
  $("autoStop").value = String(S.autoStop || 0);
  showProvider();
  checkOffline();
}

document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => setSync({ mode: r.value })));
document.querySelectorAll("input[name=engine]").forEach((r) => r.addEventListener("change", () => setSync({ engine: r.value })));
document.querySelectorAll("input[name=size]").forEach((r) => r.addEventListener("change", () => setSync({ size: r.value })));
$("lang").addEventListener("change", () => { setSync({ lang: $("lang").value }); checkOffline(); });
document.querySelectorAll("input[name=speech]").forEach((r) => r.addEventListener("change", () => { setSync({ speech: r.value }); checkOffline(); }));
$("vocab").addEventListener("change", () => setSync({ vocab: $("vocab").value.trim() }));
$("autoStop").addEventListener("change", () => setSync({ autoStop: Number($("autoStop").value) }));
for (const id of ["spokenPunct", "autoPunct", "undoBar"]) $(id).addEventListener("change", () => setSync({ [id]: $(id).checked }));

$("provider").addEventListener("change", () => { setSync({ provider: $("provider").value }); showProvider(); });
$("key").addEventListener("change", async () => {
  KEYS[S.provider] = $("key").value.trim();
  await chrome.storage.local.set({ keys: KEYS });
  if (KEYS[S.provider] && S.engine !== "ai") { // adding a key switches AI on
    document.querySelector("input[name=engine][value=ai]").checked = true;
    await setSync({ engine: "ai" });
  } else flash();
});
$("model").addEventListener("change", () => setSync({ models: { ...(S.models || {}), [S.provider]: $("model").value.trim() } }));
$("customUrl").addEventListener("change", async () => {
  const url = $("customUrl").value.trim();
  if (url) {
    try {
      const origin = new URL(url).origin + "/*";
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) { $("aiStatus").textContent = "SayIt needs permission to talk to that address."; $("aiStatus").className = "status bad"; return; }
    } catch { $("aiStatus").textContent = "That address doesn't look right."; $("aiStatus").className = "status bad"; return; }
  }
  setSync({ customUrl: url });
});

$("shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

async function runPolish(text, mode) {
  return chrome.runtime.sendMessage({ type: "polish", text, mode });
}

$("testAi").addEventListener("click", async () => {
  const st = $("aiStatus");
  if (!KEYS[S.provider]) { st.textContent = "Paste a key first."; st.className = "status bad"; return; }
  const was = S.engine;
  st.textContent = "Testing…"; st.className = "status";
  if (was !== "ai") await chrome.storage.sync.set({ engine: "ai" });
  const res = await runPolish("they was late to the meeting yesterday we start at nine", "grammar");
  if (was !== "ai") await chrome.storage.sync.set({ engine: was });
  if (!res || res.error) { st.textContent = "✗ " + (res ? res.error : "no reply"); st.className = "status bad"; return; }
  st.textContent = `✓ Works. ${(res.ms / 1000).toFixed(1)} s → "${res.text}"`;
  st.className = "status good";
});

$("test").addEventListener("click", async () => {
  const out = $("out");
  out.textContent = "Checking…"; $("testTime").textContent = "";
  let text = $("sample").value;
  const res = await runPolish(text, S.mode === "exact" ? "grammar" : S.mode);
  if (!res || res.error) { out.textContent = "Error: " + (res ? res.error : "no reply"); return; }
  out.textContent = res.text + (res.note ? "\n\n(" + res.note + ")" : "");
  $("testTime").textContent = (res.ms / 1000).toFixed(1) + " s" + (res.ai ? " with AI" : " with free checker");
});

// ----- offline speech -----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
async function checkOffline() {
  const st = $("dlStatus"), btn = $("dl");
  $("dlRow").style.display = S.speech === "local" ? "" : "none";
  if (S.speech === "whisper" && !KEYS.groq && !KEYS.openai) {
    $("aiStatus").textContent = "Most accurate speech needs a Groq or OpenAI key above."; $("aiStatus").className = "status bad";
  }
  if (!SR || typeof SR.available !== "function") {
    btn.disabled = true; st.textContent = "Your Chrome version doesn't have offline speech yet. Update Chrome to get it.";
    st.className = "status"; return;
  }
  try {
    const a = await SR.available({ langs: [S.lang], processLocally: true });
    btn.disabled = a !== "downloadable";
    st.textContent = { available: "✓ Installed for this language.", downloading: "Downloading…", downloadable: "Not installed yet.", unavailable: "Not available for this language. SayIt will use online speech." }[a] || a;
    st.className = "status " + (a === "available" ? "good" : "");
  } catch (e) { st.textContent = "Couldn't check: " + e.message; }
}
$("dl").addEventListener("click", async () => {
  $("dl").disabled = true; $("dlStatus").textContent = "Downloading… (can take a minute)";
  try {
    const ok = await SR.install({ langs: [S.lang], processLocally: true });
    $("dlStatus").textContent = ok ? "✓ Installed." : "Download failed. Try again later.";
    $("dlStatus").className = "status " + (ok ? "good" : "bad");
  } catch (e) { $("dlStatus").textContent = "Download failed: " + e.message; $("dlStatus").className = "status bad"; }
  setTimeout(checkOffline, 1500);
});

load();
