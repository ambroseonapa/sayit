(() => {
  if (window.__sayit) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const DEFAULTS = {
    mode: "grammar", engine: "free", lang: "en-GB", spokenPunct: true, autoPunct: true, undoBar: true,
    speech: "chrome", autoStop: 0, size: "l"
  };
  const MODES = {
    exact: { label: "Exact words", hint: "types exactly what you say" },
    grammar: { label: "Fix grammar", hint: "fixes grammar and punctuation, keeps your words" },
    rephrase: { label: "Rephrase", hint: "rewrites it clearly (AI)" }
  };
  const SIZES = ["m", "l", "xl"];
  const SIZE_VARS = {
    m:  { w: 600, f: 15, t: 17, h: 70 },
    l:  { w: 780, f: 17, t: 21, h: 110 },
    xl: { w: 980, f: 19, t: 26, h: 160 }
  };

  let state = "idle"; // idle | listening | working
  let rec = null, target = null, savedRange = null, savedSel = null;
  let segments = [], interim = "", stopRequested = false, cancelled = false, local = false, netErrors = 0, micLost = false, listenStatus = "";
  let docsEl = null, docsInserted = false; // Google Docs
  let settings = { ...DEFAULTS };
  let host = null, root = null, toastTimer = null, stopTimer = null, silenceTimer = null, watchdog = null;
  let spec = null, specTimer = null; // grammar fixed in the background while you speak
  let recorder = null, chunks = [], micStream = null; // audio for Whisper
  let lastSpeech = 0, workingSince = 0;
  let last = null;
  const ACTIONS = new Map(); // our buttons -> what they do

  // ---------- focus helpers ----------
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  function isTextInput(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel"].includes(t);
  }
  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA" || isTextInput(el)) return !el.readOnly && !el.disabled;
    return false;
  }
  function saveCaret() {
    if (!target) return;
    if (target.isContentEditable) {
      const sel = getSelection();
      if (sel.rangeCount && target.contains(sel.getRangeAt(0).startContainer)) savedRange = sel.getRangeAt(0).cloneRange();
    } else {
      savedSel = { start: target.selectionStart ?? target.value.length, end: target.selectionEnd ?? target.value.length };
    }
  }
  function restoreCaret() {
    if (!target) return;
    if (deepActive() !== target) target.focus({ preventScroll: true });
    if (target.isContentEditable) {
      const sel = getSelection();
      const inside = sel.rangeCount && target.contains(sel.getRangeAt(0).startContainer);
      if (!inside && savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
      if (!sel.rangeCount) { // no caret at all: put it at the end
        const r = document.createRange(); r.selectNodeContents(target); r.collapse(false); sel.addRange(r);
      }
    } else if (savedSel && document.activeElement !== target) {
      target.setSelectionRange(savedSel.start, savedSel.end);
    }
  }
  function textBeforeCaret() {
    if (!target) return "";
    try {
      if (target.isContentEditable) {
        const sel = getSelection();
        if (!sel.rangeCount) return "";
        const r = sel.getRangeAt(0);
        const pre = document.createRange();
        pre.selectNodeContents(target);
        pre.setEnd(r.startContainer, r.startOffset);
        return pre.toString().slice(-40);
      }
      const i = target.selectionStart ?? target.value.length;
      return target.value.slice(Math.max(0, i - 40), i);
    } catch { return ""; }
  }

  // ---------- inserting ----------
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function insertText(text) {
    restoreCaret();
    if (target.isContentEditable) {
      if (!document.execCommand("insertText", false, text)) {
        const sel = getSelection();
        const r = sel.getRangeAt(0); r.deleteContents();
        const node = document.createTextNode(text); r.insertNode(node);
        r.setStartAfter(node); sel.removeAllRanges(); sel.addRange(r);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      return { start: null, len: text.length };
    }
    const el = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value;
    const ok = document.execCommand("insertText", false, text);
    if (!ok || el.value === before) {
      setNativeValue(el, before.slice(0, start) + text + before.slice(end));
      el.setSelectionRange(start + text.length, start + text.length);
    }
    return { start, len: text.length };
  }
  function replaceLast(newText) {
    if (!last || !target) return;
    target.focus({ preventScroll: true });
    if (target.isContentEditable) {
      document.execCommand("undo");
      if (newText) document.execCommand("insertText", false, newText);
    } else {
      target.setSelectionRange(last.start, last.start + last.len);
      if (!document.execCommand("insertText", false, newText) || newText === "") {
        const v = target.value;
        setNativeValue(target, v.slice(0, last.start) + newText + v.slice(last.start + last.len));
      }
      target.setSelectionRange(last.start + newText.length, last.start + newText.length);
      last.len = newText.length;
    }
  }

  // ---------- turning speech into text ----------
  function spokenPunct(t) {
    const rules = [
      [/\s*\bnew paragraph\b[.,]?\s*/gi, "\n\n"],
      [/\s*\bnew line\b[.,]?\s*/gi, "\n"],
      [/\s*\bfull stop\b[.,]?/gi, "."],
      [/\s*\bcomma\b[.,]?/gi, ","],
      [/\s*\bquestion mark\b[.,?]?/gi, "?"],
      [/\s*\bexclamation (mark|point)\b[.,!]?/gi, "!"],
      [/\s*\bsemicolon\b/gi, ";"],
      [/\s*\bcolon\b/gi, ":"],
      [/\bopen bracket\s*/gi, "("],
      [/\s*\bclose bracket\b/gi, ")"]
    ];
    for (const [re, rep] of rules) t = t.replace(re, rep);
    return t.replace(/([.,;:?!])\1+/g, "$1").replace(/([.,;:?!])(?=[^\s.,;:?!)\n])/g, "$1 ");
  }
  const Q_WORDS = /^(what|why|how|when|where|who|whom|whose|which|is|are|am|was|were|do|does|did|can|could|would|will|should|shall|may|might|have|has|had|isn't|aren't|don't|doesn't|didn't|can't|won't|wouldn't|shouldn't)\b/i;
  function lastSentence(p) { return p.split(/[.?!\n]\s*/).filter(Boolean).pop() || p; }
  function sentenceCase(t, fixI) {
    t = t.replace(/(^|[.?!]\s+|\n)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
    if (fixI) t = t.replace(/\bi\b(?=('m|'ve|'ll|'d)?\b)/g, "I");
    return t;
  }
  function prepare(segs, { fromWhisper = false } = {}) {
    const free = settings.mode === "grammar" && settings.engine !== "ai";
    const auto = free && settings.autoPunct && !fromWhisper; // Whisper punctuates by itself
    let parts = segs.map((s) => s.trim()).filter(Boolean).map((s) => (settings.spokenPunct ? spokenPunct(s) : s));
    if (auto) {
      parts = parts.map((p) => (/[.?!,:;\n]$/.test(p) ? p : p + (Q_WORDS.test(lastSentence(p).trim()) ? "?" : ".")));
    }
    let t = parts.join(" ").replace(/ *\n */g, "\n").trim();
    return sentenceCase(t, settings.mode !== "exact");
  }

  // ---------- UI (shadow DOM so the page's styles can't touch it) ----------
  const CSS = `
    :host { all: initial; }
    .bar, .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647;
      font: var(--f)/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f4f1ea;
      background: #1c1f26; border-radius: 18px; box-shadow: 0 14px 40px rgba(0,0,0,.4); box-sizing: border-box;
      pointer-events: auto; user-select: none; }
    .bar { width: min(var(--w), calc(100vw - 32px)); padding: .85em 1em 1em; }
    .row { display: flex; align-items: center; gap: .55em; flex-wrap: wrap; }
    .dot { width: .8em; height: .8em; border-radius: 50%; background: #ff5a3c; flex: none;
      box-shadow: 0 0 0 0 rgba(255,90,60,.6); animation: pulse 1.3s infinite; }
    .working .dot { background: #f5b83d; animation: spin .8s linear infinite; border-radius: 3px; }
    @keyframes pulse { 70% { box-shadow: 0 0 0 .7em rgba(255,90,60,0); } 100% { box-shadow: 0 0 0 0 rgba(255,90,60,0); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { font-weight: 650; flex: 1; min-width: 6em; }
    .chip { font-size: .72em; color: #9fd8b0; border: 1px solid #355a42; border-radius: 999px; padding: .1em .6em; cursor: help; }
    .pill { background: #2c313c; color: #f4f1ea; border: 1px solid #3a404d; border-radius: 999px;
      padding: .3em .75em; font: inherit; font-size: .8em; cursor: pointer; }
    .pill:hover { border-color: #ff5a3c; }
    .size { display: inline-flex; border: 1px solid #3a404d; border-radius: 999px; overflow: hidden; }
    .size button { background: #2c313c; color: #f4f1ea; border: 0; font: inherit; font-size: .8em; padding: .3em .65em; cursor: pointer; }
    .size button + button { border-left: 1px solid #3a404d; }
    .size button:hover { background: #3a404d; }
    button.act { border: 0; border-radius: .6em; padding: .5em 1.05em; font: inherit; font-weight: 650; cursor: pointer; }
    .done { background: #ff5a3c; color: #fff; }
    .done:hover { background: #ff7154; }
    .cancel { background: transparent; color: #b8b4ab; }
    .cancel:hover { color: #fff; }
    button:disabled { opacity: .45; cursor: default; }
    .text { margin-top: .7em; min-height: var(--h); max-height: 40vh; overflow: auto; white-space: pre-wrap; word-wrap: break-word;
      font-size: var(--t); line-height: 1.45; color: #fbf8f2; background: #14161b; border-radius: .6em; padding: .55em .7em; box-sizing: border-box; user-select: text; }
    .hint { color: #8c8a85; }
    .interim { color: #9a978f; }
    .toast { padding: .75em .9em; display: flex; gap: .7em; align-items: center; width: max-content; max-width: calc(100vw - 32px); }
    .toast .msg { flex: 1; }
    .link { background: none; border: 0; color: #ffb199; font: inherit; font-weight: 650; cursor: pointer; padding: .15em .3em; white-space: nowrap; }
    .link:hover { color: #fff; text-decoration: underline; }
    .err { border-left: 4px solid #ff5a3c; }
    .pillbar { padding: .4em .5em .4em .85em; gap: .35em; font-size: .85em; border-radius: 999px; bottom: 20px; }
    .pillbar .ok { color: #7fd99a; font-weight: 700; }
    .pillbar .link { font-weight: 600; padding: .2em .55em; border-radius: 999px; }
    .pillbar .link:hover { background: #2c313c; text-decoration: none; }
  `;
  function applySize() {
    if (!host) return;
    const v = SIZE_VARS[settings.size] || SIZE_VARS.l;
    host.style.setProperty("--w", v.w + "px");
    host.style.setProperty("--f", v.f + "px");
    host.style.setProperty("--t", v.t + "px");
    host.style.setProperty("--h", v.h + "px");
  }
  function ensureRoot() {
    if (!host || !host.isConnected) {
      host = document.createElement("sayit-ui");
      root = host.attachShadow({ mode: "open" });
      const st = document.createElement("style"); st.textContent = CSS; root.appendChild(st);
      (document.body || document.documentElement).appendChild(host);
    }
    applySize();
  }
  function clearUI() { ACTIONS.clear(); if (root) [...root.querySelectorAll(".bar,.toast")].forEach((n) => n.remove()); }
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function btn(cls, text, fn, title) { const b = el("button", cls, text); if (title) b.title = title; ACTIONS.set(b, fn); return b; }

  // Websites (Gmail, pop-up forms) often swallow clicks outside their own boxes, which made
  // "Done" ignore you. So we catch the press on the whole window, before the page sees it.
  function onPointer(e) {
    if (!host || !host.isConnected) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(host)) return;
    const b = path.find((n) => ACTIONS.has(n));
    if (!b) {
      if (e.type === "mousedown" || e.type === "pointerdown") e.preventDefault(); // keep the cursor in the text box
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "pointerdown" && e.button === 0 && !b.disabled) {
      try { ACTIONS.get(b)(); } catch (err) { console.warn("SayIt", err); }
    }
  }
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) window.addEventListener(type, onPointer, true);

  function renderBar() {
    ensureRoot();
    clearToast();
    let bar = root.querySelector(".bar");
    if (!bar) {
      bar = el("div", "bar");
      const row = el("div", "row");
      const size = el("span", "size");
      size.append(btn("", "A−", () => resize(-1), "Smaller"), btn("", "A+", () => resize(1), "Bigger"));
      row.append(el("span", "dot"), el("span", "status"), el("span", "chip"), size,
        btn("pill mode", "", cycleMode), btn("act cancel", "Cancel", () => stop(true)), btn("act done", "Done", () => stop(false)));
      bar.append(row, el("div", "text"));
      root.appendChild(bar);
    }
    bar.classList.toggle("working", state === "working");
    const status = bar.querySelector(".status");
    if (state !== "working") status.textContent = listenStatus || "Listening…";
    const chip = bar.querySelector(".chip");
    const chipText = settings.speech === "whisper" ? "most accurate" : local ? "on this computer" : "";
    chip.textContent = chipText; chip.style.display = chipText ? "" : "none";
    chip.title = settings.speech === "whisper"
      ? "Your recording is sent to Whisper when you press Done, for the most accurate text."
      : "Your voice is turned into text on this computer, not on Google's servers.";
    const m = MODES[settings.mode] || MODES.grammar;
    const mb = bar.querySelector(".mode"); mb.textContent = m.label + " ▾"; mb.title = m.hint + ". Click to change.";
    const t = bar.querySelector(".text");
    const said = segments.join(" ");
    t.textContent = said;
    if (interim) t.appendChild(el("span", "interim", (said ? " " : "") + interim));
    if (!said && !interim) t.appendChild(el("span", "hint", "Start speaking… Say \"comma\", \"full stop\" or \"new line\" any time."));
    t.scrollTop = t.scrollHeight;
    bar.querySelectorAll(".mode,.done").forEach((b) => (b.disabled = state === "working"));
  }
  function setStatus(s) { const n = root && root.querySelector(".bar .status"); if (n) n.textContent = s; }
  function clearToast() {
    clearTimeout(toastTimer);
    if (root) root.querySelectorAll(".toast").forEach((n) => { n.querySelectorAll("button").forEach((b) => ACTIONS.delete(b)); n.remove(); });
  }
  // Small pill after inserting: disappears after 3 s, or as soon as you carry on typing.
  function pill(msg, actions) {
    if (!settings.undoBar) return;
    ensureRoot(); clearUI();
    const t = el("div", "toast pillbar");
    t.appendChild(el("span", "ok", "✓"));
    t.appendChild(el("span", "msg", msg));
    for (const [label, fn, title] of actions) t.appendChild(btn("link", label, () => { clearToast(); fn(); }, title));
    root.appendChild(t);
    toastTimer = setTimeout(clearToast, 3000);
    t.addEventListener("mouseenter", () => clearTimeout(toastTimer));
    t.addEventListener("mouseleave", () => { toastTimer = setTimeout(clearToast, 1500); });
  }
  function toast(msg, actions = [], { error = false, ms = 7000 } = {}) {
    ensureRoot(); clearUI();
    const t = el("div", "toast" + (error ? " err" : ""));
    t.appendChild(el("span", "msg", msg));
    for (const [label, fn] of actions) t.appendChild(btn("link", label, () => { clearToast(); fn(); }));
    t.appendChild(btn("link", "✕", clearToast, "Close"));
    root.appendChild(t);
    toastTimer = setTimeout(clearToast, ms);
  }
  function save(obj) { try { chrome.storage.sync.set(obj); } catch {} }
  function resize(d) {
    const i = Math.max(0, Math.min(SIZES.length - 1, SIZES.indexOf(settings.size) + d));
    settings.size = SIZES[i]; save({ size: settings.size }); applySize();
  }
  function cycleMode() {
    const order = ["exact", "grammar", "rephrase"];
    settings.mode = order[(order.indexOf(settings.mode) + 1) % order.length];
    save({ mode: settings.mode });
    spec = null; scheduleSpec();
    renderBar();
  }

  // ---------- talking to the background ----------
  function send(msg) {
    return chrome.runtime.sendMessage(msg).then((r) => {
      if (!r || r.error) throw new Error(r ? r.error : "no reply");
      return r;
    });
  }
  function polishReq(text) { const p = send({ type: "polish", text, mode: settings.mode }); p.catch(() => {}); return p; }
  function scheduleSpec() {
    if (settings.mode === "exact" || settings.speech === "whisper") return; // Whisper re-hears it all at the end
    clearTimeout(specTimer);
    specTimer = setTimeout(() => {
      if (state !== "listening") return;
      const t = prepare(segments);
      if (!t || (spec && spec.text === t)) return;
      spec = { text: t, promise: polishReq(t) };
    }, settings.engine === "ai" || settings.mode === "rephrase" ? 300 : 900);
  }
  function timeout(p, ms, what) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what || "took too long")), ms))]);
  }

  // ---------- audio for Whisper ----------
  async function startRecorder() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      recorder = new MediaRecorder(micStream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
      chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(1000);
    } catch { recorder = null; stopMic(); }
  }
  function stopMic() { if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; } }
  function stopRecorder() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") { stopMic(); return resolve(null); }
      const r = recorder;
      r.onstop = () => { stopMic(); resolve(chunks.length ? new Blob(chunks, { type: r.mimeType || "audio/webm" }) : null); };
      try { r.stop(); } catch { stopMic(); resolve(null); }
    });
  }
  function blobToBase64(b) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(b); });
  }

  // ---------- recording ----------
  const ERRORS = {
    "not-allowed": "Microphone is blocked for this site. Click the icon on the left of the address bar, allow Microphone, then try again.",
    "service-not-allowed": "This page doesn't allow voice input. Try another page, or allow the microphone in site settings.",
    "audio-capture": "No microphone found. Plug one in or check your sound settings.",
    "network": "Couldn't reach Chrome's speech service. Check your internet.",
    "language-not-supported": "Chrome can't do speech in that language. Change it in SayIt settings."
  };

  function reset() { // back to a clean state, whatever happened
    clearTimeout(stopTimer); clearTimeout(specTimer); clearInterval(silenceTimer); clearTimeout(watchdog);
    try { rec && rec.abort(); } catch {}
    if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch {} }
    stopMic(); recorder = null;
    state = "idle";
  }

  async function start() {
    if (!SR) { toast("This browser doesn't support voice typing. Use Google Chrome.", [], { error: true }); return; }
    if (!docsEl) { target = deepActive(); saveCaret(); }
    segments = []; interim = ""; stopRequested = false; cancelled = false; last = null; spec = null; netErrors = 0; micLost = false; listenStatus = ""; local = false;
    state = "listening"; lastSpeech = Date.now();
    try { settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) }; } catch {}
    renderBar();
    try { chrome.runtime.sendMessage({ type: "warm" }).catch(() => {}); } catch {}

    if (settings.speech === "local" && typeof SR.available === "function") {
      try { local = (await timeout(SR.available({ langs: [settings.lang], processLocally: true }), 1500)) === "available"; } catch { local = false; }
      renderBar();
    }
    if (settings.speech === "whisper") startRecorder(); // runs alongside the live preview
    if (state !== "listening") return;
    begin();

    clearInterval(silenceTimer);
    if (settings.autoStop > 0) {
      silenceTimer = setInterval(() => {
        if (state === "listening" && (segments.length || interim) && Date.now() - lastSpeech > settings.autoStop * 1000) stop(false);
      }, 300);
    }
  }

  function begin() {
    rec = new SR();
    rec.lang = settings.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    if (local && "processLocally" in rec) rec.processLocally = true;
    const me = rec;
    rec.onresult = (e) => {
      if (rec !== me) return;
      interim = "";
      let gotFinal = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const said = r[0].transcript.trim();
        if (!said) continue;
        if (r.isFinal) { segments.push(said); gotFinal = true; }
        else interim += (interim ? " " : "") + said;
      }
      lastSpeech = Date.now();
      if (netErrors || listenStatus) { netErrors = 0; listenStatus = ""; }
      if (state === "listening") renderBar();
      if (gotFinal) scheduleSpec();
      if (stopRequested && !interim) finish();
    };
    rec.onerror = (e) => {
      if (rec !== me) return;
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (local && state === "listening") { local = false; try { me.abort(); } catch {} return; } // fall back to online
      if (stopRequested) return finish();
      if (["not-allowed", "service-not-allowed", "language-not-supported"].includes(e.error)) {
        if (segments.length || interim) { // keep what you said; you decide when to insert it
          micLost = true; listenStatus = "Microphone stopped. Press Done to insert what you said.";
          renderBar(); return;
        }
        reset();
        toast(ERRORS[e.error] || "Voice input stopped: " + e.error, [], { error: true, ms: 12000 });
        return;
      }
      // Internet hiccup or similar: never end your dictation, just reconnect and keep listening.
      netErrors++;
      listenStatus = netErrors > 12 ? "Weak connection, still trying… (Done inserts what you've said)" : "Reconnecting…";
      renderBar();
    };
    rec.onend = () => {
      if (rec !== me || state !== "listening") return;
      if (stopRequested) return finish();
      if (micLost) return; // waiting for you to press Done
      // Chrome ends its session after pauses and after about a minute. Start a new one straight away,
      // so you can talk for as long as you like. Only slow down if the connection keeps failing.
      const wait = netErrors ? Math.min(3000, 250 * netErrors) : 0;
      setTimeout(() => {
        if (rec !== me || state !== "listening" || stopRequested) return;
        try { begin(); } catch { setTimeout(() => { if (rec === me && state === "listening" && !stopRequested) { try { begin(); } catch {} } }, 1000); }
      }, wait);
    };
    try { rec.start(); } catch (e) { reset(); toast("Couldn't start the microphone: " + e.message, [], { error: true }); }
  }

  function stop(cancel) {
    if (state === "working") { if (cancel) { reset(); clearUI(); } return; }
    if (state !== "listening") return;
    cancelled = cancel; stopRequested = true;
    clearInterval(silenceTimer);
    if (cancel) return finish();
    try { rec && rec.stop(); } catch {}
    clearTimeout(stopTimer);
    stopTimer = setTimeout(finish, interim ? 450 : 150);
  }

  async function finish() {
    clearTimeout(stopTimer); clearTimeout(specTimer); clearInterval(silenceTimer);
    if (state !== "listening") return;
    if (cancelled) { reset(); clearUI(); return; }
    const segs = interim ? [...segments, interim] : segments.slice();
    try { rec && rec.abort(); } catch {}

    state = "working"; workingSince = Date.now();
    // Safety net: if anything hangs, never leave the bar stuck on screen.
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (state === "working") { reset(); toast("That took too long, so SayIt stopped. Please try again.", [], { error: true }); }
    }, 25000);

    try {
      renderBar();
      let raw = prepare(segs);
      let note = "";

      if (settings.speech === "whisper") {
        setStatus("Getting your exact words…");
        const audio = await timeout(stopRecorder(), 2000).catch(() => null);
        if (audio && audio.size > 2000) {
          try {
            const r = await timeout(send({ type: "transcribe", audio: await blobToBase64(audio), mime: audio.type, lang: settings.lang }), 13000);
            const heard = r.text;
            const fake = /thank(s| you) for watching|subtitles by|amara\.org/i;
            if (heard && !(fake.test(heard) && !fake.test(raw))) raw = prepare([heard], { fromWhisper: true });
          } catch (err) { note = "Accurate speech failed (" + err.message + "), used the quick version."; }
        }
      } else stopMic();

      if (!raw) { reset(); toast("Didn't catch anything. Tap SayIt and try again."); return; }

      const mode = settings.mode;
      let res = { text: raw, changes: 0 };
      if (mode !== "exact") {
        setStatus(mode === "rephrase" ? "Rephrasing…" : "Fixing grammar…");
        try {
          const p = spec && spec.text === raw ? spec.promise : polishReq(raw);
          res = await timeout(p, mode === "rephrase" ? 15000 : 8000);
        } catch (err) {
          res = { text: raw, changes: 0, note: "Grammar check failed (" + err.message + "). Inserted your words." };
        }
      }
      if (note && !res.note) res.note = note;

      const before = textBeforeCaret();
      const prev = before.slice(-1);
      const lastReal = before.replace(/[ \t ]+$/, "").slice(-1);
      const midSentence = !!lastReal && !/[.?!\n:]/.test(lastReal);
      let out = res.text, rawOut = raw;
      if (midSentence) {
        const lowerFirst = (s) => (/^I\b/.test(s) ? s : s.replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase()));
        if (/^\p{Ll}/u.test(segs[0] || "")) { out = lowerFirst(out); rawOut = lowerFirst(rawOut); }
      }
      const lead = prev && !/\s/.test(prev) && !/^[,.;:?!)]/.test(out) ? " " : "";
      out = lead + out; rawOut = lead + rawOut;

      if (docsEl) {
        const lead2 = docsInserted ? " " : "";
        const ok = insertDocs(lead2 + out);
        docsInserted = true;
        reset();
        if (!ok) {
          copyText(lead2 + out);
          toast("Google Docs didn't accept it directly, so it's copied. Press Ctrl+V to paste.", [], { error: true, ms: 9000 });
        } else if (res.note) toast(res.note, [], { error: true });
        else pill("Inserted · Ctrl+Z to undo", []);
        return;
      }

      const ins = insertText(out);
      last = { ...ins, raw: rawOut, polished: out };
      reset();

      if (res.note) { toast(res.note, [["Undo", () => replaceLast("")]], { error: true }); return; }
      const actions = [];
      if (out !== rawOut) actions.push(["Original", () => replaceLast(rawOut), "Put back your exact words"]);
      actions.push(["↶ Undo", () => replaceLast(""), "Remove what was inserted (or press Ctrl+Z)"]);
      pill(mode === "exact" ? "Inserted" : res.rephrased ? "Rephrased" : out === rawOut ? "Inserted" : "Fixed", actions);
    } catch (err) {
      console.warn("SayIt", err);
      reset();
      toast("Something went wrong: " + err.message, [], { error: true });
    }
  }

  // ---------- Google Docs ----------
  // Docs draws its own text, but it listens for typing in a hidden box inside a frame.
  // We hand it the text the same way a paste does.
  const IS_DOCS = location.hostname === "docs.google.com" && /^\/(document|presentation)\//.test(location.pathname);
  function docsInput(a) {
    if (!IS_DOCS || !a || a.tagName !== "IFRAME" || !a.classList.contains("docs-texteventtarget-iframe")) return null;
    try {
      const d = a.contentDocument;
      const x = d && d.activeElement;
      return x && x !== d.documentElement ? x : d && d.body;
    } catch { return null; }
  }
  function insertDocs(text) {
    const elx = docsEl;
    try { elx.focus(); } catch {}
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      elx.dispatchEvent(ev);
      if (ev.defaultPrevented) return true; // Docs took it
    } catch {}
    try { return elx.ownerDocument.execCommand("insertText", false, text); } catch { return false; }
  }
  function copyText(text) {
    try { navigator.clipboard.writeText(text); return; } catch {}
    try {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove();
    } catch {}
  }

  function toggle() {
    if (state === "listening") return stop(false);
    if (state === "working") { reset(); clearUI(); return; } // tapping the icon always closes it
    try { if (window.frameElement && window.frameElement.classList.contains("docs-texteventtarget-iframe")) return; } catch {} // the main page handles Docs
    if (!document.hasFocus()) return;
    const a = deepActive();
    const d = docsInput(a);
    if (d) { docsEl = d; target = null; return start(); }
    docsEl = null;
    if (a && (a.tagName === "IFRAME" || a.tagName === "FRAME")) return;
    if (!isEditable(a)) {
      if (window === window.top) toast("Click inside a text box first, then tap SayIt (or press Alt+Shift+S).");
      return;
    }
    start();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state !== "idle") { e.stopPropagation(); stop(true); return; }
    if (state === "idle" && root && root.querySelector(".pillbar")) clearToast();
  }, true);

  window.__sayit = {
    toggle,
    _test: { prepare: (s) => prepare(s), settings: (o) => Object.assign(settings, o), state: () => state,
      useExact: () => replaceLast(last.raw), undo: () => replaceLast(""), host: () => host }
  };
})();
