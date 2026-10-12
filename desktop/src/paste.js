// Types text into whatever app has the cursor: put it on the clipboard, press Ctrl+V (Cmd+V on Mac),
// then put back whatever was on the clipboard before.
const { clipboard } = require("electron");
const { execFile, spawn } = require("child_process");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Windows: press keys directly through user32 (fast, no extra programs) ----------
let win = null;
function winApi() {
  if (win !== null) return win;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    win = {
      koffi,
      GetForegroundWindow: user32.func("void * __stdcall GetForegroundWindow()"),
      SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(void *hWnd)"),
      IsWindow: user32.func("bool __stdcall IsWindow(void *hWnd)"),
      keybd_event: user32.func("void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)"),
      GetAsyncKeyState: user32.func("int16_t __stdcall GetAsyncKeyState(int vKey)")
    };
  } catch (e) { console.warn("SayIt: koffi unavailable, using PowerShell", e); win = false; }
  return win;
}
const VK = { SHIFT: 0x10, CONTROL: 0x11, ALT: 0x12, LWIN: 0x5b, RWIN: 0x5c, V: 0x56 };
const KEYUP = 0x0002;

async function waitForModifiersReleased(api) {
  // If you're still holding Alt+Shift from the shortcut, Ctrl+V would become Ctrl+Alt+Shift+V.
  for (let i = 0; i < 40; i++) {
    const held = [VK.SHIFT, VK.ALT, VK.CONTROL, VK.LWIN, VK.RWIN].some((k) => api.GetAsyncKeyState(k) & 0x8000);
    if (!held) return;
    await sleep(25);
  }
}

async function pressPasteWindows() {
  const api = winApi();
  if (api) {
    await waitForModifiersReleased(api);
    api.keybd_event(VK.CONTROL, 0, 0, 0);
    api.keybd_event(VK.V, 0, 0, 0);
    api.keybd_event(VK.V, 0, KEYUP, 0);
    api.keybd_event(VK.CONTROL, 0, KEYUP, 0);
    return;
  }
  await new Promise((res) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"], { windowsHide: true }, () => res()));
}

// ---------- Mac: System Events (needs Accessibility permission once) ----------
function pressPasteMac() {
  return new Promise((res, rej) => execFile("osascript", ["-e",
    'tell application "System Events" to keystroke "v" using command down'], (err) => (err ? rej(err) : res())));
}

// ---------- Linux (for testing): xdotool if present ----------
function pressPasteLinux() {
  return new Promise((res) => { const p = spawn("xdotool", ["key", "--clearmodifiers", "ctrl+v"]); p.on("error", res); p.on("exit", res); });
}

function saveClipboard() {
  try {
    const formats = clipboard.availableFormats();
    return {
      text: clipboard.readText(),
      html: formats.some((f) => f.includes("html")) ? clipboard.readHTML() : "",
      image: formats.some((f) => f.includes("image")) ? clipboard.readImage() : null
    };
  } catch { return null; }
}
function restoreClipboard(old) {
  if (!old) return;
  try {
    const data = {};
    if (old.text) data.text = old.text;
    if (old.html) data.html = old.html;
    if (old.image && !old.image.isEmpty()) data.image = old.image;
    if (Object.keys(data).length) clipboard.write(data); else clipboard.clear();
  } catch {}
}

// ---------- Windows: remember the app you were typing in, and go back to it ----------
// The SayIt box is a normal window you can click (Windows sometimes ignored clicks on a box that
// never takes focus). Clicking it moves the focus to SayIt, so before typing we switch back to
// the app you were in when you started speaking.
let target = null;
function rememberTarget(ownHandles) {
  if (!isWin) return;
  const api = winApi(); if (!api) return;
  try {
    const fg = api.GetForegroundWindow();
    const addr = fg ? Number(api.koffi.address(fg)) : 0;
    if (addr && !ownHandles.includes(addr)) target = fg;
  } catch {}
}
async function restoreTarget(ownHandles) {
  if (!isWin || !target) return;
  const api = winApi(); if (!api) return;
  try {
    if (!api.IsWindow(target)) return;
    const fg = api.GetForegroundWindow();
    const addr = fg ? Number(api.koffi.address(fg)) : 0;
    if (addr && !ownHandles.includes(addr)) return; // you're already in an app (maybe you clicked into another one): type there
    if (!api.SetForegroundWindow(target)) {
      // Windows only lets the app in front switch windows; a quick Alt press counts as "in front".
      api.keybd_event(VK.ALT, 0, 0, 0); api.keybd_event(VK.ALT, 0, KEYUP, 0);
      api.SetForegroundWindow(target);
    }
    await sleep(120); // let the app put its cursor back
  } catch {}
}

async function typeText(text, ownHandles) {
  await restoreTarget(ownHandles || []);
  const old = saveClipboard();
  clipboard.writeText(text);
  await sleep(30);
  if (isWin) await pressPasteWindows();
  else if (isMac) await pressPasteMac();
  else await pressPasteLinux();
  // Give the app time to read the clipboard before we put the old contents back.
  setTimeout(() => { if (clipboard.readText() === text) restoreClipboard(old); }, 900);
}

module.exports = { typeText, rememberTarget, restoreTarget };
