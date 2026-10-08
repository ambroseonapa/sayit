// Hidden page that records your voice for the "Fast & accurate (Groq)" speech mode.
// It cuts the recording at each pause and hands every piece to the background, which sends it to Whisper
// while you keep talking. Same method as the SayIt desktop app.
const RATE = 16000, FRAME = 320; // 20 ms frames

let stream = null, ctx = null, node = null, src = null, recorder = null, chunks = [];
let cur = null, noise = 0.004, seq = 0, frames = 0, running = false;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "start") { start().then(reply, (e) => reply({ error: e.name === "NotAllowedError" || e.name === "SecurityError" ? "mic-permission" : e.message || String(e) })); return true; }
  if (msg.type === "stop") { stop(false).then(reply); return true; }
  if (msg.type === "cancel") { stop(true).then(reply); return true; }
});

function wav(list) {
  const n = list.reduce((a, f) => a + f.length, 0);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const f of list) for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Uint8Array(buf);
}
function b64(bytes) {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
const send = (m) => chrome.runtime.sendMessage({ ...m, target: "background" }).catch(() => {});

function onFrame(f) {
  if (!running) return;
  frames++;
  let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  const rms = Math.sqrt(sum / f.length);
  const speaking = rms > Math.max(0.012, noise * 3);
  if (!speaking) noise = noise * 0.97 + rms * 0.03;
  if (frames % 5 === 0) send({ type: "level", v: Math.min(1, rms * 8) });

  if (!cur) cur = { frames: [], flags: [], speech: 0, silence: 0, told: false };
  cur.frames.push(f); cur.flags.push(speaking);
  if (speaking) { cur.speech++; cur.silence = 0; } else cur.silence++;
  if (cur.speech < 5) {
    if (cur.frames.length > 20) {
      const drop = cur.frames.length - 20;
      cur.frames.splice(0, drop); cur.flags.splice(0, drop);
      cur.speech = cur.flags.filter(Boolean).length;
    }
    if (cur.speech < 5) return;
  }
  if (!cur.told) { cur.told = true; send({ type: "speaking" }); }
  const secs = cur.frames.length * FRAME / RATE;
  // A pause of 0.6 s after at least a second of talking, or a long piece: send it now.
  if ((cur.silence >= 30 && secs >= 1.0) || secs >= 25) cut();
}

function cut() {
  const c = cur; cur = null;
  if (!c || c.speech < 8) return false;
  const keep = c.frames.length - Math.max(0, c.silence - 15);
  send({ type: "seg", id: ++seq, audio: b64(wav(c.frames.slice(0, keep))), mime: "audio/wav" });
  return true;
}

async function start() {
  await stop(true);
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  running = true; cur = null; noise = 0.004; seq = 0; frames = 0; chunks = [];
  // Backup: a plain recording of everything, used only if the live cutting gets no audio.
  try {
    recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000 } : undefined);
    recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    recorder.start(1000);
  } catch { recorder = null; }
  ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  if (ctx.state !== "running") { try { await ctx.resume(); } catch {} }
  src = ctx.createMediaStreamSource(stream);
  try {
    await ctx.audioWorklet.addModule("recorder-worklet.js");
    node = new AudioWorkletNode(ctx, "recorder");
    node.port.onmessage = (e) => onFrame(e.data);
    src.connect(node);
  } catch {
    // Older Chrome: fall back to ScriptProcessor
    node = ctx.createScriptProcessor(4096, 1, 1);
    let buf = new Float32Array(0);
    node.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      const all = new Float32Array(buf.length + d.length); all.set(buf); all.set(d, buf.length);
      let i = 0; for (; i + FRAME <= all.length; i += FRAME) onFrame(all.slice(i, i + FRAME));
      buf = all.slice(i);
    };
    src.connect(node); node.connect(ctx.destination);
  }
  return { ok: true };
}

async function stop(cancel) {
  const wasRunning = running;
  running = false;
  let sent = 0;
  if (wasRunning && !cancel && cut()) sent = 1;
  // If live cutting never received audio, send the backup recording as one piece.
  if (wasRunning && !cancel && frames === 0 && seq === 0 && recorder) {
    const blob = await new Promise((res) => { recorder.onstop = () => res(new Blob(chunks, { type: recorder.mimeType || "audio/webm" })); try { recorder.stop(); } catch { res(null); } });
    if (blob && blob.size > 2000) { send({ type: "seg", id: ++seq, audio: b64(new Uint8Array(await blob.arrayBuffer())), mime: blob.type }); }
  }
  try { recorder && recorder.state !== "inactive" && recorder.stop(); } catch {}
  try { node && node.port && (node.port.onmessage = null); src && src.disconnect(); node && node.disconnect && node.disconnect(); } catch {}
  try { ctx && (await ctx.close()); } catch {}
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = ctx = node = src = recorder = null;
  return { count: seq };
}
