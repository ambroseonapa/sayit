// Windows: watch the mouse buttons directly, so clicking the floating mic always works.
// The mic window never takes focus (so your text box keeps the cursor). On some Windows
// computers that kind of window does not get normal click events, so the click was lost.
// Here we ask Windows itself whether the mouse button is down and where the pointer is.
//   press + release on the mic, moved less than 10 px  -> click (start / stop)
//   press on the mic and move                          -> drag the mic
//   right button released on the mic                  -> menu
const { screen } = require("electron");

function load() {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    return {
      GetAsyncKeyState: user32.func("short __stdcall GetAsyncKeyState(int vKey)"),
      GetSystemMetrics: user32.func("int __stdcall GetSystemMetrics(int nIndex)")
    };
  } catch { return null; }
}

function inside(p, b) { return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height; }

// opts: { getButton, onClick, onDrag(dx, dy), onDragEnd, onMenu }
let lastPress = 0, leftNow = false, lastClickAt = null;
// true if Windows told us about a press on the mic in the last few seconds (then the window's own
// click event is not needed, and ignoring it avoids counting a drag as a click)
function sawPress() { return Date.now() - lastPress < 3000; }
// is the main mouse button held down right now?
function leftDown() { return leftNow; }
// where you last clicked outside SayIt (that's usually where you're typing), or null
function lastClick() { return lastClickAt && Date.now() - lastClickAt.t < 15 * 60000 ? lastClickAt : null; }

function start(opts) {
  const api = opts.api || load(); // opts.api and opts.screen are only for tests
  const scr = opts.screen || screen;
  if (!api) return false;
  const VK_LBUTTON = 0x01, VK_RBUTTON = 0x02, SM_SWAPBUTTON = 23;
  let left = null, right = false;
  setInterval(() => {
    const btn = opts.getButton();
    if (!btn || btn.isDestroyed()) { left = null; right = false; return; }
    let swapped = false;
    try { swapped = api.GetSystemMetrics(SM_SWAPBUTTON) !== 0; } catch {}
    const isDown = (vk) => (api.GetAsyncKeyState(vk) & 0x8000) !== 0;
    const lDown = isDown(swapped ? VK_RBUTTON : VK_LBUTTON);
    const rDown = isDown(swapped ? VK_LBUTTON : VK_RBUTTON);
    const p = scr.getCursorScreenPoint();
    const b = btn.getBounds();
    if (lDown && !leftNow) {
      const others = (opts.getOthers ? opts.getOthers() : []).filter((w) => w && !w.isDestroyed() && w.isVisible());
      if (!inside(p, b) && !others.some((w) => inside(p, w.getBounds()))) lastClickAt = { x: p.x, y: p.y, h: 18, t: Date.now(), from: "click" };
    }
    leftNow = lDown;

    if (!btn.isVisible()) { left = null; right = false; return; } // button hidden: only track clicks

    // primary button
    if (lDown && !left) {
      left = inside(p, b) ? { sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false } : { outside: true };
      if (!left.outside) lastPress = Date.now();
    } else if (lDown && left && !left.outside) {
      if (!left.moved && Math.hypot(p.x - left.sx, p.y - left.sy) >= 10) left.moved = true;
      if (left.moved && (p.x !== left.x || p.y !== left.y)) { opts.onDrag(p.x - left.x, p.y - left.y); left.x = p.x; left.y = p.y; }
    } else if (!lDown && left) {
      const was = left; left = null;
      if (!was.outside) {
        if (was.moved) opts.onDragEnd();
        else opts.onClick();
      }
    }

    // secondary button: menu
    if (rDown && !right) right = inside(p, b);
    else if (!rDown && right) { right = false; if (inside(p, b)) opts.onMenu(); }
  }, 20);
  return true;
}

module.exports = { start, sawPress, leftDown, lastClick };
