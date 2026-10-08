(() => {
  if (window.__sayit) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const DEFAULTS = {
    mode: "grammar", engine: "free", lang: "en-GB", spokenPunct: true, autoPunct: true, undoBar: true,
    speech: "groq", autoStop: 0, size: "l", theme: "system", showChanges: false,
    barBox: null // where you dragged the box and how big you made it: { x, y, w, h } (null = bottom middle)
  };
  const MODES = {
    exact: { label: "Exact words", hint: "types exactly what you say" },
    grammar: { label: "Fix grammar", hint: "fixes grammar and punctuation, keeps your words" },
    polish: { label: "Polish", hint: "puts your words together clearly, keeps your voice (AI)" },
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
  let useGroq = false, gsegs = [], gSpeaking = false; // "Fast & accurate (Groq)" speech: pieces transcribed at each pause
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
    :host(.dark)  { --bg:#1c1f26; --fg:#f4f1ea; --muted:#9a978f; --sub:#2c313c; --line:#3a404d; --textbg:#14161b; --text:#fbf8f2; --wait:#9a978f; --link:#ffb199; --ok:#7fd99a; }
    :host(.light) { --bg:#ffffff; --fg:#1c1f26; --muted:#6b6862; --sub:#f3f0ea; --line:#e4dfd5; --textbg:#faf7f1; --text:#1c1f26; --wait:#8c8a85; --link:#c43d22; --ok:#1f7a3f; }
    :host(.light) .bar, :host(.light) .toast { box-shadow: 0 14px 40px rgba(0,0,0,.18), 0 0 0 1px var(--line); }
    .bar, .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647;
      font: var(--f)/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg);
      background: var(--bg); border-radius: 18px; box-shadow: 0 14px 40px rgba(0,0,0,.4); box-sizing: border-box;
      pointer-events: auto; user-select: none; }
    .bar { width: min(var(--w), calc(100vw - 32px)); padding: .85em 1em 1em; }
    .row { display: flex; align-items: center; gap: .55em; flex-wrap: wrap; }
    .dot { width: .8em; height: .8em; border-radius: 50%; background: #ff5a3c; flex: none;
      box-shadow: 0 0 0 0 rgba(255,90,60,.6); animation: pulse 1.3s infinite; }
    .working .dot { background: #f5b83d; animation: spin .8s linear infinite; border-radius: 3px; }
    @keyframes pulse { 70% { box-shadow: 0 0 0 .7em rgba(255,90,60,0); } 100% { box-shadow: 0 0 0 0 rgba(255,90,60,0); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { font-weight: 650; flex: 1; min-width: 6em; }
    .chip { font-size: .72em; color: var(--ok); border: 1px solid var(--line); border-radius: 999px; padding: .1em .6em; cursor: help; }
    .pill { background: var(--sub); color: var(--fg); border: 1px solid var(--line); border-radius: 999px;
      padding: .3em .75em; font: inherit; font-size: .8em; cursor: pointer; }
    .pill:hover { border-color: #ff5a3c; }
    .size { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
    .size button { background: var(--sub); color: var(--fg); border: 0; font: inherit; font-size: .8em; padding: .3em .65em; cursor: pointer; }
    .size button + button { border-left: 1px solid var(--line); }
    .size button:hover { background: var(--line); }
    button.act { border: 0; border-radius: .6em; padding: .5em 1.05em; font: inherit; font-weight: 650; cursor: pointer; }
    .done { background: #ff5a3c; color: #fff; }
    .done:hover { background: #ff7154; }
    .cancel { background: transparent; color: var(--muted); }
    .cancel:hover { color: var(--fg); }
    button:disabled { opacity: .45; cursor: default; }
    .text { margin-top: .7em; min-height: var(--h); max-height: 40vh; overflow: auto; white-space: pre-wrap; word-wrap: break-word;
      font-size: var(--t); line-height: 1.45; color: var(--text); background: var(--textbg); border-radius: .6em; padding: .55em .7em; box-sizing: border-box; user-select: text; }
    .hint { color: var(--muted); }
    .interim { color: var(--wait); }
    .toast { padding: .75em .9em; display: flex; gap: .7em; align-items: center; width: max-content; max-width: calc(100vw - 32px); }
    .toast .msg { flex: 1; }
    .link { background: none; border: 0; color: var(--link); font: inherit; font-weight: 650; cursor: pointer; padding: .15em .3em; white-space: nowrap; }
    .link:hover { color: var(--fg); text-decoration: underline; }
    .err { border-left: 4px solid #ff5a3c; }
    .del { color: #d9534f; text-decoration: line-through; opacity: .8; }
    .ins { color: #2e9e5b; text-decoration: underline; text-decoration-color: rgba(46,158,91,.5); text-underline-offset: 3px; }
    :host(.dark) .ins { color: #7fd99a; }
    :host(.dark) .del { color: #ff8f7a; }
    .bar .row { cursor: grab; }
    .bar .row button, .bar .row .size { cursor: pointer; }
    .bar.moving, .bar.moving .row { cursor: grabbing; }
    .bar.custom .text { height: var(--ch); min-height: 0; max-height: none; }
    .grip { position: absolute; right: 3px; bottom: 3px; width: 16px; height: 16px; cursor: nwse-resize; opacity: .55; }
    .grip::before { content: ""; position: absolute; right: 3px; bottom: 3px; width: 9px; height: 9px;
      background: linear-gradient(135deg, transparent 45%, var(--muted) 45%, var(--muted) 55%, transparent 55%, transparent 70%, var(--muted) 70%, var(--muted) 80%, transparent 80%); }
    .pillbar { padding: .4em .5em .4em .85em; gap: .35em; font-size: .85em; border-radius: 999px; bottom: 20px; }
    .pillbar .ok { color: var(--ok); font-weight: 700; }
    .pillbar .link { font-weight: 600; padding: .2em .55em; border-radius: 999px; }
    .pillbar .link:hover { background: var(--sub); text-decoration: none; }
  `;
  function themeName() {
    const t = settings.theme || "system";
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function applySize() {
    if (!host) return;
    host.classList.remove("light", "dark"); host.classList.add(themeName());
    const v = SIZE_VARS[settings.size] || SIZE_VARS.l;
    host.style.setProperty("--w", v.w + "px");
    host.style.setProperty("--f", v.f + "px");
    host.style.setProperty("--t", v.t + "px");
    host.style.setProperty("--h", v.h + "px");
    placeBar();
  }
  // Put the box where you dragged it, at the size you gave it (kept inside the window).
  function placeBar() {
    const bar = root && root.querySelector(".bar");
    if (!bar) return;
    const b = settings.barBox;
    if (!b) { bar.classList.remove("custom"); bar.style.cssText = ""; return; }
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(320, Math.min(b.w || 600, vw - 16));
    bar.classList.add("custom");
    bar.style.width = w + "px";
    bar.style.setProperty("--ch", Math.max(50, Math.min(b.h || 110, vh - 160)) + "px");
    bar.style.transform = "none"; bar.style.bottom = "auto";
    const hgt = bar.offsetHeight || 200;
    bar.style.left = Math.max(8, Math.min(b.x, vw - w - 8)) + "px";
    bar.style.top = Math.max(8, Math.min(b.y, vh - hgt - 8)) + "px";
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
    if (!b && (e.type === "pointerdown") && e.button === 0) {
      const bar = path.find((n) => n.classList && n.classList.contains("bar"));
      const onGrip = path.some((n) => n.classList && n.classList.contains("grip"));
      const onRow = path.some((n) => n.classList && n.classList.contains("row"));
      if (bar && (onGrip || onRow)) startGesture(onGrip ? "resize" : "move", bar, e);
    }
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

  // ---------- drag the box (its top row) and resize it (bottom-right corner) ----------
  let gest = null;
  function startGesture(kind, bar, e) {
    const r = bar.getBoundingClientRect(), t = bar.querySelector(".text");
    gest = { kind, bar, sx: e.clientX, sy: e.clientY, x: r.left, y: r.top, w: r.width, h: t ? t.getBoundingClientRect().height : 110 };
    bar.classList.add("moving");
  }
  window.addEventListener("pointermove", (e) => {
    if (!gest) return;
    e.preventDefault(); e.stopPropagation();
    const dx = e.clientX - gest.sx, dy = e.clientY - gest.sy;
    const box = { x: gest.x, y: gest.y, w: gest.w, h: gest.h };
    if (gest.kind === "move") { box.x += dx; box.y += dy; } else { box.w = gest.w + dx; box.h = gest.h + dy; }
    settings.barBox = box; placeBar();
  }, true);
  const endGesture = (e) => {
    if (!gest) return;
    if (e) { e.preventDefault(); e.stopPropagation(); }
    gest.bar.classList.remove("moving");
    gest = null;
    const bar = root && root.querySelector(".bar");
    if (bar && settings.barBox) { // save what's really on screen (after keeping it inside the window)
      const r = bar.getBoundingClientRect(), t = bar.querySelector(".text");
      settings.barBox = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(t ? t.getBoundingClientRect().height : settings.barBox.h) };
    }
    save({ barBox: settings.barBox });
  };
  window.addEventListener("pointerup", endGesture, true);
  window.addEventListener("pointercancel", endGesture, true);
  window.addEventListener("blur", () => endGesture());
  window.addEventListener("resize", () => placeBar());

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
        btn("pill mode", "", cycleMode), btn("pill copy", "Copy", copyNow, "Copy the text so far"),
        btn("act cancel", "Cancel", () => stop(true)), btn("act done", "Done", () => stop(false)));
      bar.append(row, el("div", "text"), el("div", "grip"));
      bar.querySelector(".grip").title = "Drag to resize";
      row.title = "Drag to move";
      root.appendChild(bar);
      placeBar();
    }
    bar.classList.toggle("working", state === "working");
    const status = bar.querySelector(".status");
    if (state !== "working") status.textContent = listenStatus || "Listening…";
    const chip = bar.querySelector(".chip");
    const chipText = local ? "on this computer" : "";
    chip.textContent = chipText; chip.style.display = chipText ? "" : "none";
    chip.title = "Your voice is turned into text on this computer, not on Google's servers.";
    const m = MODES[settings.mode] || MODES.grammar;
    const mb = bar.querySelector(".mode"); mb.textContent = m.label + " ▾"; mb.title = m.hint + ". Click to change.";
    const t = bar.querySelector(".text");
    if (useGroq) {
      const said = gTexts().join(" ");
      const waiting = gSpeaking || gsegs.some((s) => s.status === "pending");
      t.textContent = said;
      if (waiting) t.appendChild(el("span", "interim", (said ? " " : "") + "…"));
      if (!said && !waiting) t.appendChild(el("span", "hint", "Start speaking. Your words appear each time you pause."));
    } else {
      const said = segments.join(" ");
      t.textContent = said;
      if (interim) t.appendChild(el("span", "interim", (said ? " " : "") + interim));
      if (!said && !interim) t.appendChild(el("span", "hint", "Start speaking… Say \"comma\", \"full stop\" or \"new line\" any time."));
    }
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
    const order = ["exact", "grammar", "polish", "rephrase"];
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
    if (settings.mode === "exact") return;
    clearTimeout(specTimer);
    specTimer = setTimeout(() => {
      if (state !== "listening") return;
      if (useGroq && gsegs.some((s) => s.status === "pending")) return;
      const t = useGroq ? prepare(gTexts(), { fromWhisper: true }) : prepare(segments);
      if (!t || (spec && spec.text === t)) return;
      spec = { text: t, promise: polishReq(t) };
    }, settings.engine === "ai" || settings.mode === "rephrase" ? 300 : 900);
  }
  function timeout(p, ms, what) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what || "took too long")), ms))]);
  }

  // ---------- "Fast & accurate (Groq)" speech ----------
  // A hidden SayIt page records your voice and cuts it at each pause; the background sends each piece to
  // Whisper while you keep talking, and the text comes back here piece by piece.
  function gTexts() { return gsegs.filter((s) => s.status === "done" && s.text).sort((a, b) => a.id - b.id).map((s) => s.text); }
  function gSeg(id) { let s = gsegs.find((x) => x.id === id); if (!s) { s = { id, status: "pending", text: "" }; gsegs.push(s); } return s; }
  let gError = "";
  try { chrome.runtime.onMessage.addListener((m) => {
    if (!m || !m.sayit || !useGroq || state === "idle") return;
    if (m.type === "seg-pending") { gSeg(m.id); gSpeaking = false; }
    else if (m.type === "seg-text") {
      const s = gSeg(m.id);
      s.status = m.error ? "failed" : "done"; s.text = m.text || "";
      if (m.error) gError = m.error;
      scheduleSpec();
    }
    else if (m.type === "speaking") { gSpeaking = true; lastSpeech = Date.now(); }
    else if (m.type === "level") { if (m.v > 0.12) lastSpeech = Date.now(); return; }
    if (state === "listening") renderBar();
  }); } catch {}
  function waitFor(cond, ms) {
    return new Promise((res) => { const end = Date.now() + ms; const tick = () => (cond() || Date.now() > end ? res(cond()) : setTimeout(tick, 40)); tick(); });
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

  // ---------- copy the text ----------
  function currentText() {
    if (useGroq) return prepare(gTexts(), { fromWhisper: true });
    return prepare(interim ? [...segments, interim] : segments);
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch {}
    try { if (await chrome.runtime.sendMessage({ type: "copy", text: t })) return true; } catch {}
    try { // last try: the old way, inside the page
      const ta = document.createElement("textarea"); ta.value = t; (document.body || document.documentElement).appendChild(ta);
      ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok;
    } catch { return false; }
  }
  async function copyNow() {
    const t = currentText();
    const b = root && root.querySelector(".bar .copy");
    if (!t) { if (b) { b.textContent = "Nothing yet"; setTimeout(() => (b.textContent = "Copy"), 1200); } return; }
    const ok = await copyText(t);
    if (b) { b.textContent = ok ? "Copied ✓" : "Couldn't copy"; setTimeout(() => (b.textContent = "Copy"), 1400); }
  }

  // ---------- "show the changes" view ----------
  let reviewDone = null;
  function review(before, after) {
    return new Promise((resolve) => {
      reviewDone = (v) => { reviewDone = null; resolve(v); };
      ensureRoot(); clearUI();
      const bar = el("div", "bar");
      const row = el("div", "row");
      row.append(el("span", "status", "Check the changes"),
        btn("pill", "Copy", async (e) => { await copyText(after); }, "Copy the new text"),
        btn("act cancel", "Cancel", () => reviewDone && reviewDone(null)),
        btn("pill", "Use my words", () => reviewDone && reviewDone(before), "Insert what you said, without the changes"),
        btn("act done", "Insert", () => reviewDone && reviewDone(after)));
      const t = el("div", "text");
      for (const d of sayitDiffLocal(before, after)) {
        if (d.t === "del") t.append(el("span", "del", d.w), " ");
        else if (d.t === "ins" || d.t === "fix") t.append(el("span", "ins", d.w), " ");
        else t.append(d.w + " ");
      }
      bar.append(row, t, el("div", "grip"));
      root.appendChild(bar);
      placeBar();
    });
  }
  // same word-by-word comparison as shared.js (kept here because this script runs inside web pages)
  function sayitDiffLocal(a, b) {
    const x = String(a || "").split(/\s+/).filter(Boolean), y = String(b || "").split(/\s+/).filter(Boolean);
    const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
    const n = x.length, m = y.length, L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = norm(x[i]) === norm(y[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (norm(x[i]) === norm(y[j])) { out.push({ t: x[i] === y[j] ? "same" : "fix", w: y[j] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "del", w: x[i++] });
      else out.push({ t: "ins", w: y[j++] });
    }
    while (i < n) out.push({ t: "del", w: x[i++] });
    while (j < m) out.push({ t: "ins", w: y[j++] });
    return out;
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
    if (reviewDone) reviewDone(null);
    clearTimeout(stopTimer); clearTimeout(specTimer); clearInterval(silenceTimer); clearTimeout(watchdog);
    try { rec && rec.abort(); } catch {}
    if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch {} }
    stopMic(); recorder = null;
    if (useGroq) { try { chrome.runtime.sendMessage({ type: "capture-stop", cancel: true }).catch(() => {}); } catch {} }
    useGroq = false; gSpeaking = false;
    state = "idle";
  }

  async function start() {
    if (!docsEl) { target = deepActive(); saveCaret(); }
    useGroq = false; gsegs = []; gSpeaking = false; gError = "";
    segments = []; interim = ""; stopRequested = false; cancelled = false; last = null; spec = null; netErrors = 0; micLost = false; listenStatus = ""; local = false;
    state = "listening"; lastSpeech = Date.now();
    try { settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) }; } catch {}
    if (settings.speech === "whisper") settings.speech = "groq"; // older setting name
    renderBar();
    try { chrome.runtime.sendMessage({ type: "warm" }).catch(() => {}); } catch {}

    if (settings.speech === "groq") {
      let r = null;
      try { r = await timeout(chrome.runtime.sendMessage({ type: "capture-start" }), 6000); } catch (e) { r = { error: e.message }; }
      if (state !== "listening") { if (r && r.ok) chrome.runtime.sendMessage({ type: "capture-stop", cancel: true }).catch(() => {}); return; }
      if (r && r.ok) {
        useGroq = true;
        renderBar();
        startSilenceTimer();
        return;
      }
      if (r && r.error === "mic-permission") {
        reset();
        toast("SayIt needs your permission to use the microphone. You only do this once.",
          [["Allow microphone", () => chrome.runtime.sendMessage({ type: "openMicPage" })]], { error: true, ms: 15000 });
        return;
      }
      // No Groq key, or the recorder couldn't start: use Chrome's built-in speech instead.
    }
    if (!SR) { reset(); toast("This browser doesn't support voice typing. Use Google Chrome.", [], { error: true }); return; }

    if (settings.speech === "local" && typeof SR.available === "function") {
      try { local = (await timeout(SR.available({ langs: [settings.lang], processLocally: true }), 1500)) === "available"; } catch { local = false; }
      renderBar();
    }
    if (state !== "listening") return;
    begin();
    startSilenceTimer();
  }

  function startSilenceTimer() {
    clearInterval(silenceTimer);
    if (settings.autoStop > 0) {
      silenceTimer = setInterval(() => {
        const said = useGroq ? gsegs.length || gSpeaking : segments.length || interim;
        if (state === "listening" && said && Date.now() - lastSpeech > settings.autoStop * 1000) stop(false);
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
      // Chrome throws away words it hadn't finished when a session ends. Keep them.
      if (interim) { segments.push(interim); interim = ""; renderBar(); scheduleSpec(); }
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
    if (cancel || useGroq) return finish();
    try { rec && rec.stop(); } catch {}
    clearTimeout(stopTimer);
    stopTimer = setTimeout(finish, interim ? 450 : 150);
  }

  async function finish() {
    clearTimeout(stopTimer); clearTimeout(specTimer); clearInterval(silenceTimer);
    if (state !== "listening") return;
    if (cancelled) { reset(); clearUI(); return; }
    let segs = interim ? [...segments, interim] : segments.slice();
    try { rec && rec.abort(); } catch {}

    state = "working"; workingSince = Date.now();
    // Safety net: if anything hangs, never leave the bar stuck on screen.
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (state === "working") { reset(); toast("That took too long, so SayIt stopped. Please try again.", [], { error: true }); }
    }, 25000);

    try {
      renderBar();
      let raw, note = "";

      if (useGroq) {
        setStatus("Finishing…");
        // Ask the recorder for the last piece you said, then wait for every piece to come back as text.
        let r = null;
        try { r = await timeout(chrome.runtime.sendMessage({ type: "capture-stop" }), 4000); } catch {}
        const count = (r && r.count) || 0;
        await waitFor(() => gsegs.length >= count && !gsegs.some((s) => s.status === "pending"), 15000);
        try { chrome.runtime.sendMessage({ type: "capture-end" }).catch(() => {}); } catch {}
        if (gsegs.some((s) => s.status !== "done")) note = "Some words were lost (" + (gError || "slow connection") + ").";
        segs = gTexts();
        raw = prepare(segs, { fromWhisper: true });
      } else {
        stopMic();
        raw = prepare(segs);
      }

      if (!raw) { reset(); toast(gError ? "Couldn't hear it: " + gError : "Didn't catch anything. Tap SayIt and try again.", [], { error: !!gError }); return; }

      const mode = settings.mode;
      let res = { text: raw, changes: 0 };
      if (mode !== "exact") {
        setStatus(mode === "rephrase" ? "Rephrasing…" : mode === "polish" ? "Polishing…" : "Fixing grammar…");
        try {
          const p = spec && spec.text === raw ? spec.promise : polishReq(raw);
          res = await timeout(p, mode === "rephrase" || mode === "polish" ? 20000 : 8000);
        } catch (err) {
          res = { text: raw, changes: 0, note: "Grammar check failed (" + err.message + "). Inserted your words." };
        }
      }
      if (note && !res.note) res.note = note;

      // Optional (Settings → "Show the changes"): see what changed and choose before it goes in.
      if (settings.showChanges && mode !== "exact" && !res.note && res.text.trim() !== raw.trim()) {
        clearTimeout(watchdog);
        const pick = await review(raw, res.text);
        if (pick === null) { reset(); clearUI(); return; }
        res = { ...res, text: pick };
      }

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

  function toggle() {
    if (state === "listening") return stop(false);
    if (state === "working") { reset(); clearUI(); return; } // tapping the icon always closes it
    try { if (window.frameElement && window.frameElement.classList.contains("docs-texteventtarget-iframe")) return; } catch {} // the main page handles Docs
    // Several frames can run SayIt; only the one you're typing in should answer. If no frame has
    // keyboard focus (e.g. Chrome's toolbar took it for a moment), the main page still answers
    // when it has a text box selected.
    if (!document.hasFocus() && window !== window.top) return;
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
