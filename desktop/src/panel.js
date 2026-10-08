// The box you speak into: records, cuts at pauses, shows your words, fixes grammar, types it.
const api = window.sayit;
const $ = (id) => document.getElementById(id);
const RATE = 16000, FRAME = 320; // 20 ms frames
const MODES = { exact: "Exact words", grammar: "Fix grammar", polish: "Polish", rephrase: "Rephrase" };
const TEXT_SIZES = ["s", "m", "l", "xl"];
const undoKey = api.platform === "darwin" ? "⌘Z" : "Ctrl+Z";

let settings = {};
let state = "idle"; // idle | listening | working | done
let stream = null, ctx = null, node = null, src = null;
let segs = [];          // { id, status: pending|done|failed, text }
let cur = null;         // piece being recorded
let noise = 0.004, t0 = 0, timer = null, spec = null, specTimer = null, segId = 0, lastError = "", doneTimer = null;

api.getSettings().then((s) => { settings = s; paintStatic(); });
api.on("settings", (s) => { settings = s; paintStatic(); });
api.on("toggle", () => toggle());
api.on("cancel", () => cancel());

function paintStatic() {
  document.body.classList.remove("dark", "light", "ts-s", "ts-m", "ts-l", "ts-xl");
  document.body.classList.add(settings.themeResolved || "dark", "ts-" + (settings.textSize || "l"));
  if (api.platform === "darwin") document.body.classList.add("mac");
  $("mode").textContent = (MODES[settings.mode] || MODES.grammar) + " ▾";
  const hk = (settings.hotkey || "Alt+Shift+D").replace(/Control/g, "Ctrl").replace(/Command/g, "Cmd");
  $("hk").textContent = hk + " to finish · Esc to cancel";
}
function setTextSize(d) {
  const i = Math.max(0, Math.min(TEXT_SIZES.length - 1, TEXT_SIZES.indexOf(settings.textSize || "l") + d));
  settings.textSize = TEXT_SIZES[i];
  api.setSettings({ textSize: settings.textSize });
  paintStatic();
}

$("done").addEventListener("click", () => (reviewDone ? reviewDone(reviewAfter) : finish()));
$("mine").addEventListener("click", () => reviewDone && reviewDone(reviewBefore));
$("copy").addEventListener("click", async () => {
  const t = reviewDone ? reviewAfter : fullText();
  if (!t) { $("copy").textContent = "Nothing yet"; setTimeout(() => ($("copy").textContent = "Copy"), 1200); return; }
  await api.copy(t);
  $("copy").textContent = "Copied ✓"; setTimeout(() => ($("copy").textContent = "Copy"), 1400);
});
$("cancel").addEventListener("click", () => cancel());
$("close").addEventListener("click", () => cancel());
$("settings").addEventListener("click", () => api.openSettings());
$("smaller").addEventListener("click", () => setTextSize(-1));
$("bigger").addEventListener("click", () => setTextSize(1));
$("mode").addEventListener("click", () => {
  const order = ["exact", "grammar", "polish", "rephrase"];
  settings.mode = order[(order.indexOf(settings.mode) + 1) % order.length];
  api.setSettings({ mode: settings.mode });
  spec = null; scheduleSpec(); paintStatic();
});
for (let i = 0; i < 7; i++) $("meter").appendChild(document.createElement("i"));

// ---------- move (drag the top bar) and resize (drag the corner) ----------
function dragger(el, onMove, onEnd, skip) {
  let d = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (skip && skip(e))) return;
    d = { x: e.screenX, y: e.screenY };
    try { el.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!d) return;
    const dx = e.screenX - d.x, dy = e.screenY - d.y;
    if (!dx && !dy) return;
    d.x = e.screenX; d.y = e.screenY;
    onMove(dx, dy);
  });
  const end = () => { if (d) { d = null; onEnd(); } };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
dragger($("top"), (dx, dy) => api.panelMove(dx, dy), () => api.panelMoveEnd(), (e) => e.target.closest("button"));
dragger($("grip"), (dx, dy) => api.panelResize(dx, dy), () => api.panelResizeEnd());

// ---------- UI ----------
function setState(s, msg) {
  state = s;
  document.body.classList.toggle("working", s === "working");
  document.body.classList.toggle("done", s === "done");
  $("done").disabled = s !== "listening";
  $("mode").disabled = s !== "listening";
  if (msg) $("status").textContent = msg;
  api.panelState(s);
}
function paintText() {
  const t = $("text");
  const done = segs.filter((x) => x.status === "done" && x.text).map((x) => x.text).join(" ");
  const pending = segs.some((x) => x.status === "pending") || (cur && cur.speech > 5);
  t.textContent = done;
  if (pending) { const w = document.createElement("span"); w.className = "wait"; w.textContent = (done ? " " : "") + "…"; t.appendChild(w); }
  if (!done && !pending) { const h = document.createElement("span"); h.className = "hint"; h.textContent = "Start speaking. Your words appear here each time you pause."; t.appendChild(h); }
  t.scrollTop = t.scrollHeight;
}
function paintMeter(level) {
  const bars = $("meter").children;
  for (let i = 0; i < bars.length; i++) {
    const v = Math.max(3, Math.min(16, level * 240 * (0.6 + 0.4 * Math.sin(Date.now() / 90 + i * 1.7))));
    bars[i].style.height = v + "px";
  }
}

// ---------- audio ----------
function wav(frames) {
  const n = frames.reduce((a, f) => a + f.length, 0);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const f of frames) for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return buf;
}

function onFrame(f) {
  if (state !== "listening") return;
  let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  const rms = Math.sqrt(sum / f.length);
  paintMeter(rms);
  const speaking = rms > Math.max(0.012, noise * 3);
  if (!speaking) noise = noise * 0.97 + rms * 0.03; // learn the room's background noise

  if (!cur) cur = { frames: [], flags: [], speech: 0, silence: 0 };
  cur.frames.push(f); cur.flags.push(speaking);
  if (speaking) { cur.speech++; cur.silence = 0; } else cur.silence++;

  const secs = cur.frames.length * FRAME / RATE;
  if (cur.speech < 5) {
    // nothing said yet: keep only the last 0.4 s, so the start of your first word isn't cut off
    if (cur.frames.length > 20) {
      const drop = cur.frames.length - 20;
      cur.frames.splice(0, drop); cur.flags.splice(0, drop);
      cur.speech = cur.flags.filter(Boolean).length;
    }
    if (cur.speech < 5) return;
  }
  // You paused (0.6 s) after at least a second of talking, or this piece is getting long: send it now.
  if ((cur.silence >= 30 && secs >= 1.0) || secs >= 25) cutSegment();
  else if (cur.speech === 5) paintText();
}

function cutSegment() {
  const c = cur; cur = null;
  if (!c || c.speech < 8) return; // too short to be words
  const keep = c.frames.length - Math.max(0, c.silence - 15); // trim long trailing silence
  const audio = wav(c.frames.slice(0, keep));
  const seg = { id: ++segId, status: "pending", text: "" };
  segs.push(seg);
  paintText();
  const before = segs.filter((x) => x.status === "done").map((x) => x.text).join(" ").slice(-300);
  api.transcribe(audio, before).then((r) => {
    if (!segs.includes(seg)) return;
    if (r.error) { seg.status = "failed"; lastError = r.error; }
    else { seg.status = "done"; seg.text = r.text; }
    paintText();
    scheduleSpec();
  });
}

async function startMic() {
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  if (ctx.state !== "running") await ctx.resume();
  await ctx.audioWorklet.addModule("recorder-worklet.js");
  src = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "recorder");
  node.port.onmessage = (e) => onFrame(e.data);
  src.connect(node);
}
function stopMic() {
  try { node && (node.port.onmessage = null); src && src.disconnect(); } catch {}
  try { ctx && ctx.close(); } catch {}
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = ctx = node = src = null;
}

// ---------- grammar while you speak ----------
const fullText = () => segs.filter((x) => x.status === "done" && x.text).map((x) => x.text).join(" ").trim();
function scheduleSpec() {
  if (settings.mode === "exact" || state !== "listening") return;
  clearTimeout(specTimer);
  specTimer = setTimeout(() => {
    if (segs.some((x) => x.status === "pending")) return;
    const t = fullText();
    if (!t || (spec && spec.text === t)) return;
    spec = { text: t, p: api.polish(t, settings.mode) };
  }, 250);
}

// ---------- flow ----------
function toggle() {
  if (state === "listening") return finish();
  if (state === "working") return;
  start();
}

async function start() {
  clearTimeout(doneTimer);
  if (!settings.hasKey) {
    setState("done", "SayIt needs a speech key: Groq (free, fastest), OpenAI or Gemini. Claude can fix grammar but can't listen. Opening settings…");
    doneTimer = setTimeout(() => { close(); api.openSettings(); }, 4000);
    return;
  }
  segs = []; cur = null; spec = null; noise = 0.004; lastError = "";
  setState("listening", "Listening…");
  paintText();
  t0 = Date.now();
  clearInterval(timer);
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $("time").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }, 250);
  $("time").textContent = "0:00";
  try {
    if (!(await api.micAccess())) throw new Error("not allowed");
    await startMic();
  } catch (e) {
    stopMic(); clearInterval(timer);
    setState("done", "Microphone blocked. Allow SayIt to use the microphone in your system settings.");
    doneTimer = setTimeout(close, 5000);
  }
}

// ---------- "show the changes" view (Settings → off by default) ----------
let reviewDone = null, reviewBefore = "", reviewAfter = "";
function review(before, after) {
  return new Promise((resolve) => {
    reviewBefore = before; reviewAfter = after;
    reviewDone = (v) => { reviewDone = null; $("mine").hidden = true; $("done").textContent = "Done"; $("mode").hidden = false; resolve(v); };
    setState("working", "Check the changes");
    $("done").disabled = false; $("done").textContent = "Insert"; $("mine").hidden = false; $("mode").hidden = true;
    const t = $("text"); t.textContent = "";
    for (const d of S_diff(before, after)) {
      if (d.t === "same") t.append(d.w + " ");
      else { const s = document.createElement("span"); s.className = d.t === "del" ? "del" : "ins"; s.textContent = d.w; t.append(s, " "); }
    }
  });
}
function S_diff(a, b) {
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

function cancel() {
  if (reviewDone) { reviewDone(null); return; }
  if (state === "idle") return;
  stopMic(); clearInterval(timer); clearTimeout(specTimer);
  segs = []; cur = null;
  close();
}

function close() { clearTimeout(doneTimer); setState("idle"); }

function waitForSegments(ms) {
  return new Promise((res) => {
    const end = Date.now() + ms;
    const check = () => (!segs.some((x) => x.status === "pending") || Date.now() > end ? res() : setTimeout(check, 40));
    check();
  });
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ error: "took too long" }), ms))]);

async function finish() {
  if (state !== "listening") return;
  setState("working", "Finishing…");
  clearInterval(timer);
  cutSegment();      // send the last words you said
  stopMic();
  await waitForSegments(15000);
  let text = fullText();
  if (!text) {
    setState("done", lastError ? "Couldn't hear it: " + lastError : "Didn't catch anything. Try again.");
    doneTimer = setTimeout(close, lastError ? 5000 : 2000);
    return;
  }

  let note = "";
  if (settings.mode !== "exact") {
    $("status").textContent = settings.mode === "rephrase" ? "Rephrasing…" : settings.mode === "polish" ? "Polishing…" : "Fixing grammar…";
    const slow = settings.mode === "rephrase" || settings.mode === "polish";
    const said = text;
    const r = await withTimeout(spec && spec.text === text ? spec.p : api.polish(text, settings.mode), slow ? 20000 : 8000);
    if (r && !r.error && r.text) text = r.text;
    else if (r && r.error) note = "grammar fix skipped (" + r.error + ")";
    if (r && r.note) note = r.note;
    if (settings.showChanges && !note && text.trim() !== said.trim()) {
      const pick = await review(said, text);
      if (pick === null) { segs = []; close(); return; }
      text = pick;
    }
  }
  if (/[.?!]$/.test(text)) text += " "; // so your next sentence starts cleanly

  $("status").textContent = "Typing…";
  const res = await api.type(text);
  if (res && res.error === "mac-accessibility") {
    setState("done", "Copied. Press ⌘V to paste, and allow SayIt under System Settings › Privacy › Accessibility.");
    doneTimer = setTimeout(close, 7000);
    return;
  }
  const lost = segs.some((x) => x.status === "failed") ? "some words were lost (" + (lastError || "slow connection") + ")" : "";
  const warn = [note, lost].filter(Boolean).join("; ");
  setState("done", warn ? "Inserted, but " + warn : "Inserted · " + undoKey + " to undo");
  doneTimer = setTimeout(() => { if (state === "done") close(); }, warn ? 4000 : 1200);
}

paintStatic();
setState("idle");
