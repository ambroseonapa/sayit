const api = window.sayit;
const $ = (id) => document.getElementById(id);
const RATE = 16000, FRAME = 320; // 20 ms frames
const MODES = { exact: "Exact words", grammar: "Fix grammar", rephrase: "Rephrase" };

let settings = {};
let state = "idle"; // idle | listening | working | done
let stream = null, ctx = null, node = null, src = null;
let segs = [];          // { id, status: pending|done|failed, text }
let cur = null;         // segment being recorded: { frames: [], speech: 0, silence: 0 }
let noise = 0.004, t0 = 0, timer = null, spec = null, specTimer = null, segId = 0, lastError = "";

api.getSettings().then((s) => { settings = s; paintStatic(); });
api.on("settings", (s) => { settings = s; paintStatic(); });
api.on("toggle", () => toggle());
api.on("cancel", () => cancel());

const PANEL_SIZES = ["m", "l", "xl"];
function resizePanel(d) {
  const i = Math.max(0, Math.min(2, PANEL_SIZES.indexOf(settings.panelSize || "l") + d));
  settings.panelSize = PANEL_SIZES[i];
  api.setSettings({ panelSize: settings.panelSize });
  paintStatic();
}
function paintStatic() {
  document.body.classList.remove("sz-m", "sz-l", "sz-xl");
  document.body.classList.add("sz-" + (settings.panelSize || "l"));
  $("mode").textContent = (MODES[settings.mode] || MODES.grammar) + " ▾";
  $("hk").textContent = (settings.hotkey || "Alt+Shift+D").replace("CommandOrControl", "Ctrl") + " to finish · Esc to cancel";
  $("btn").title = "SayIt: click to speak (" + (settings.hotkey || "Alt+Shift+D") + ") · right-click for menu";
}

// ---------- button: click to speak, drag to move, right-click for menu ----------
let down = null;
$("btn").addEventListener("pointerdown", (e) => {
  if (e.button === 2) return;
  down = { x: e.screenX, y: e.screenY, moved: false };
  $("btn").setPointerCapture(e.pointerId);
});
$("btn").addEventListener("pointermove", (e) => {
  if (!down) return;
  const dx = e.screenX - down.x, dy = e.screenY - down.y;
  if (!down.moved && Math.hypot(dx, dy) < 4) return;
  down.moved = true;
  api.drag(dx, dy);
  down.x = e.screenX; down.y = e.screenY;
});
$("btn").addEventListener("pointerup", () => {
  if (!down) return;
  const moved = down.moved; down = null;
  if (moved) api.dragEnd(); else toggle();
});
$("btn").addEventListener("contextmenu", (e) => { e.preventDefault(); api.menu(); });
$("done").addEventListener("click", () => finish());
$("cancel").addEventListener("click", () => cancel());
$("settings").addEventListener("click", () => api.openSettings());
$("smaller").addEventListener("click", () => resizePanel(-1));
$("bigger").addEventListener("click", () => resizePanel(1));
$("mode").addEventListener("click", () => {
  const order = ["exact", "grammar", "rephrase"];
  settings.mode = order[(order.indexOf(settings.mode) + 1) % 3];
  api.setSettings({ mode: settings.mode });
  spec = null; scheduleSpec(); paintStatic();
});
for (let i = 0; i < 9; i++) $("meter").appendChild(document.createElement("i"));

// ---------- UI ----------
function setState(s, msg) {
  state = s;
  document.body.classList.toggle("exp", s !== "idle");
  document.body.classList.toggle("working", s === "working");
  document.body.classList.toggle("done", s === "done");
  $("done").disabled = s !== "listening";
  $("mode").disabled = s !== "listening";
  if (msg) $("status").textContent = msg;
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
    const v = Math.max(3, Math.min(18, level * 260 * (0.6 + 0.4 * Math.sin(Date.now() / 90 + i * 1.7))));
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
  const threshold = Math.max(0.012, noise * 3);
  const speaking = rms > threshold;
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
  // You paused (0.7 s) after at least a second of talking, or this piece is getting long: send it now.
  if ((cur.silence >= 35 && secs >= 1.2) || secs >= 28) cutSegment();
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
async function toggle() {
  if (state === "listening") return finish();
  if (state === "working") return;
  start();
}

async function start() {
  if (!settings.hasKey) { api.openSettings(); return; }
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
  api.expand(true);
  try {
    if (!(await api.micAccess())) throw new Error("not allowed");
    await startMic();
  } catch (e) {
    stopMic(); clearInterval(timer);
    setState("done", "Microphone blocked. Allow SayIt to use the microphone in your system settings.");
    setTimeout(collapse, 5000);
  }
}

function cancel() {
  if (state === "idle") return;
  stopMic(); clearInterval(timer); clearTimeout(specTimer);
  segs = []; cur = null;
  collapse();
}

function collapse() { setState("idle"); api.expand(false); }

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
    setTimeout(collapse, lastError ? 5000 : 2000);
    return;
  }
  if (segs.some((x) => x.status === "failed")) lastError = lastError || "part of it failed";

  let note = "";
  if (settings.mode !== "exact") {
    $("status").textContent = settings.mode === "rephrase" ? "Rephrasing…" : "Fixing grammar…";
    const r = await withTimeout(spec && spec.text === text ? spec.p : api.polish(text, settings.mode), settings.mode === "rephrase" ? 15000 : 8000);
    if (r && !r.error && r.text) text = r.text;
    else if (r && r.error) note = "grammar fix skipped (" + r.error + ")";
    if (r && r.note) note = r.note;
  }
  if (/[.?!]$/.test(text)) text += " "; // so your next sentence starts cleanly

  $("status").textContent = "Typing…";
  const res = await api.type(text);
  if (res && res.error === "mac-accessibility") {
    setState("done", "Copied. Press ⌘V to paste, and allow SayIt under System Settings › Privacy › Accessibility.");
    setTimeout(collapse, 7000);
    return;
  }
  const warn = [note, segs.some((x) => x.status === "failed") ? "some words were lost (" + lastError + ")" : ""].filter(Boolean).join("; ");
  setState("done", warn ? "Inserted, but " + warn : "Inserted · " + (api.platform === "darwin" ? "⌘Z" : "Ctrl+Z") + " to undo");
  setTimeout(() => { if (state === "done") collapse(); }, warn ? 4000 : 1300);
}

setState("idle");
