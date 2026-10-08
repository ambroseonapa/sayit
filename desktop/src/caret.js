// Finds where you're typing, so the SayIt box can open right there.
//  1. Windows: ask the system for the text cursor (caret) of the app in front. Works in Word,
//     Notepad, Outlook and most classic apps. (Chrome, Edge and some newer apps don't report it.)
//  2. Otherwise: the last place the mouse rested (that's where you clicked to start typing).
const { screen } = require("electron");

const isWin = process.platform === "win32";

let win = null;
function winApi() {
  if (win !== null) return win;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const RECT = koffi.struct("SAYIT_RECT", { left: "long", top: "long", right: "long", bottom: "long" });
    const POINT = koffi.struct("SAYIT_POINT", { x: "long", y: "long" });
    const GUI = koffi.struct("SAYIT_GUITHREADINFO", {
      cbSize: "uint32", flags: "uint32",
      hwndActive: "void *", hwndFocus: "void *", hwndCapture: "void *", hwndMenuOwner: "void *",
      hwndMoveSize: "void *", hwndCaret: "void *", rcCaret: RECT
    });
    win = {
      koffi, GUI,
      GetGUIThreadInfo: user32.func("bool __stdcall GetGUIThreadInfo(uint32 idThread, _Inout_ SAYIT_GUITHREADINFO *pgui)"),
      ClientToScreen: user32.func("bool __stdcall ClientToScreen(void *hWnd, _Inout_ SAYIT_POINT *lpPoint)")
    };
  } catch (e) { win = false; }
  return win;
}

// Returns { x, y, h } in screen coordinates (DIP), or null.
function caretPoint() {
  if (!isWin) return null;
  const api = winApi();
  if (!api) return null;
  try {
    const gui = { cbSize: api.koffi.sizeof(api.GUI) };
    if (!api.GetGUIThreadInfo(0, gui) || !gui.hwndCaret) return null;
    const r = gui.rcCaret;
    if (r.right === 0 && r.bottom === 0 && r.left === 0 && r.top === 0) return null;
    const pt = { x: r.left, y: r.top };
    if (!api.ClientToScreen(gui.hwndCaret, pt)) return null;
    const p = screen.screenToDipPoint ? screen.screenToDipPoint({ x: pt.x, y: pt.y }) : pt;
    const scale = screen.getDisplayNearestPoint(p).scaleFactor || 1;
    return { x: p.x, y: p.y, h: Math.max(14, (r.bottom - r.top) / scale), from: "caret" };
  } catch { return null; }
}

// Mouse history: remember where the pointer rested, so clicking the SayIt button
// (which moves the mouse away) still knows where you were typing.
const log = [];
let timer = null;
function startTracking() {
  if (timer) return;
  timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    log.push({ x: p.x, y: p.y, t: Date.now() });
    if (log.length > 120) log.shift();
  }, 150);
}
function inside(p, r) { return r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height; }

// Last point (outside `avoid`) where the mouse stayed still for at least ~0.3 s, within the last 30 s.
function lastRestingPoint(avoid) {
  const now = Date.now();
  for (let i = log.length - 1; i >= 2; i--) {
    const a = log[i], b = log[i - 1], c = log[i - 2];
    if (now - a.t > 30000) break;
    if (inside(a, avoid)) continue;
    const still = Math.abs(a.x - b.x) <= 3 && Math.abs(a.y - b.y) <= 3 && Math.abs(b.x - c.x) <= 3 && Math.abs(b.y - c.y) <= 3;
    if (still && !inside(b, avoid)) return { x: a.x, y: a.y, h: 18, from: "mouse" };
  }
  return null;
}

// Where to open the box. `source` is "hotkey", "button" or "tray"; `avoid` is the button's area.
function typingPoint(source, avoid) {
  const c = caretPoint();
  if (c) return c;
  if (source === "button") return lastRestingPoint(avoid);
  const p = screen.getCursorScreenPoint();
  return { x: p.x, y: p.y, h: 18, from: "mouse" };
}

module.exports = { typingPoint, startTracking, caretPoint };
