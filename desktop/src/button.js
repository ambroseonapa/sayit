// The round floating mic button. Click = start/stop. Drag = move it. Right-click = menu.
const api = window.sayit;
const btn = document.getElementById("btn");

function applyLook(s) {
  document.body.className = s.themeResolved || "dark";
  btn.title = "SayIt: click to speak (" + (s.hotkey || "Alt+Shift+D") + ") · drag to move · right-click for menu";
}
api.getSettings().then(applyLook);
api.on("settings", applyLook);
api.on("recording", (on) => document.body.classList.toggle("rec", !!on));

// A click is a press that didn't travel far. Hands move a little while clicking (especially on
// touchpads), so only count it as a drag after 10 px.
let down = null, lastClick = 0;
function click() {
  if (Date.now() - lastClick < 400) return; // pointerup and click can both fire
  lastClick = Date.now();
  api.buttonClick();
}
btn.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY, sx: e.screenX, sy: e.screenY, moved: false };
  try { btn.setPointerCapture(e.pointerId); } catch {}
});
btn.addEventListener("pointermove", (e) => {
  if (!down) return;
  if (!down.moved && Math.hypot(e.screenX - down.sx, e.screenY - down.sy) < 10) return;
  down.moved = true;
  api.drag(e.screenX - down.x, e.screenY - down.y);
  down.x = e.screenX; down.y = e.screenY;
});
btn.addEventListener("pointerup", () => {
  if (!down) return;
  const moved = down.moved; down = null;
  if (moved) api.dragEnd(); else click();
});
btn.addEventListener("pointercancel", () => { if (down && down.moved) api.dragEnd(); down = null; });
// Backup: some systems deliver only a plain click to windows that don't take focus.
btn.addEventListener("click", () => { if (!down) click(); });
btn.addEventListener("contextmenu", (e) => { e.preventDefault(); api.menu(); });
