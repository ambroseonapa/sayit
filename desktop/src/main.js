const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, nativeTheme, session, systemPreferences, shell, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const core = require("./core.js");
const { typeText } = require("./paste.js");
const caret = require("./caret.js");
const winmouse = require("./winmouse.js");
const updater = require("./updater.js");
const S = require("./shared.js");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const BUTTONS = { s: 48, m: 64, l: 84 };
const PANEL_DEFAULT = { w: 420, h: 280 };   // a wide square: easy to read, not too big
const PANEL_MIN = { w: 320, h: 190 };

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
// The shortcut doesn't count as a "click", so let audio start without one.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// The box never takes focus (so your cursor stays in your app). Chromium can then decide the
// box is "covered", stop drawing it and slow down its timers, which looks like a frozen box
// after a few minutes of talking. Turn that off: SayIt's windows are tiny, so it costs nothing.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,IntensiveWakeUpThrottling");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// ---------- settings ----------
const DEFAULTS = {
  ...S.SAYIT_DEFAULTS,
  engine: "ai", provider: "groq", keys: {}, models: {}, customUrl: "",
  hotkey: "Alt+Shift+D", showBubble: true, pos: null, firstRun: true,
  bubbleSize: "m", textSize: "l", theme: "system",
  panelW: PANEL_DEFAULT.w, panelH: PANEL_DEFAULT.h,
  panelPlace: "typing",   // "typing" (where you're typing) | "remember" (where you last left it) | "button" (next to the mic)
  panelPos: null
};
let settingsFile, settings;
function loadSettings() {
  settingsFile = path.join(app.getPath("userData"), "settings.json");
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, "utf8")) }; }
  catch { settings = { ...DEFAULTS }; }
  if (settings.panelSize && !settings.textSizeMigrated) { // 0.5 setting → text size
    settings.textSize = { m: "m", l: "l", xl: "xl" }[settings.panelSize] || "l";
    settings.textSizeMigrated = true;
  }
  if (!settings.sizeFix082) { // 0.8.1 and older could make the box grow while dragging it
    if ((settings.panelW || 0) >= 520 || (settings.panelH || 0) >= 360) { settings.panelW = PANEL_DEFAULT.w; settings.panelH = PANEL_DEFAULT.h; }
    settings.sizeFix082 = true;
  }
}
let saveTimer = null;
function saveSettings(now) {
  clearTimeout(saveTimer);
  const write = () => { try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.warn(e); } };
  if (now) write(); else saveTimer = setTimeout(write, 300);
}
// A small log file to help if something doesn't work (tray menu → "Open log").
function debugLog(msg) {
  try {
    const f = path.join(app.getPath("userData"), "sayit-log.txt");
    try { if (fs.statSync(f).size > 200000) fs.writeFileSync(f, ""); } catch {}
    fs.appendFileSync(f, new Date().toISOString() + "  " + msg + "\n");
  } catch {}
}
const themeResolved = () => (settings.theme === "light" ? "light" : settings.theme === "dark" ? "dark" : nativeTheme.shouldUseDarkColors ? "dark" : "light");
const publicSettings = () => {
  const { keys, ...rest } = settings;
  return { ...rest, hasKey: core.speechKey(settings), themeResolved: themeResolved() };
};
function broadcast() {
  for (const w of [button, panel]) if (w && !w.isDestroyed()) w.webContents.send("settings", publicSettings());
  if (panel && !panel.isDestroyed()) panel.setBackgroundColor(themeResolved() === "dark" ? "#1c1f26" : "#ffffff");
}

// ---------- windows ----------
let button = null, panel = null, settingsWin = null, tray = null;
let panelState = "idle";

const buttonPx = () => BUTTONS[settings.bubbleSize] || BUTTONS.m;
function clampToScreen(b) {
  const wa = screen.getDisplayMatching(b).workArea;
  const width = Math.min(b.width, wa.width), height = Math.min(b.height, wa.height);
  return {
    x: Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width)),
    y: Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height)),
    width: Math.round(width), height: Math.round(height)
  };
}
function buttonBounds() {
  const px = buttonPx();
  const wa = screen.getPrimaryDisplay().workArea;
  const p = settings.pos || { x: wa.x + wa.width - px - 24, y: wa.y + wa.height - px - 120 };
  return clampToScreen({ x: p.x, y: p.y, width: px, height: px });
}

// Windows that sit on top and never take the cursor away from the app you're typing in.
function floatingWindow(opts) {
  const w = new BrowserWindow({
    frame: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false,
    focusable: !isWin, // Windows: clicks don't steal focus. Mac: a "panel" window does the same.
    ...(isMac ? { type: "panel", hiddenInMissionControl: true } : {}),
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
    ...opts
  });
  w.setAlwaysOnTop(true, "screen-saver");
  if (isMac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.env.SAYIT_TEST) w.webContents.on("console-message", (...a) => { const e = a[0] && a[0].message ? a[0] : { message: a[2] }; fs.appendFileSync(process.env.SAYIT_TEST, JSON.stringify({ console: e.message }) + "\n"); });
  return w;
}

function createButton() {
  button = floatingWindow({ ...buttonBounds(), transparent: true, resizable: false, hasShadow: false });
  button.loadFile(path.join(__dirname, "button.html"));
  button.once("ready-to-show", () => { if (settings.showBubble) button.showInactive(); });
}

function createPanel() {
  panel = floatingWindow({
    width: settings.panelW, height: settings.panelH, minWidth: PANEL_MIN.w, minHeight: PANEL_MIN.h,
    resizable: true, hasShadow: true, roundedCorners: true,
    backgroundColor: themeResolved() === "dark" ? "#1c1f26" : "#ffffff"
  });
  panel.loadFile(path.join(__dirname, "panel.html"));
  panel.webContents.on("render-process-gone", (_e, d) => recoverPanel("crashed (" + (d && d.reason) + ")"));
  panel.on("unresponsive", () => { if (panelState === "listening" || panelState === "working") recoverPanel("stopped responding"); });
  // Resizing from the window's own edges: remember that size too.
  panel.on("resized", () => {
    if (gesture || !panel.isVisible()) return;
    const b = panel.getBounds();
    settings.panelW = b.width; settings.panelH = b.height; saveSettings();
  });
}

// Where the box opens: right under where you're typing (or where you last left it / next to the mic).
function panelBounds(source) {
  const w = Math.max(PANEL_MIN.w, settings.panelW || PANEL_DEFAULT.w);
  const h = Math.max(PANEL_MIN.h, settings.panelH || PANEL_DEFAULT.h);
  const btn = button && !button.isDestroyed() ? button.getBounds() : buttonBounds();
  if (settings.panelPlace === "remember" && settings.panelPos) return clampToScreen({ ...settings.panelPos, width: w, height: h });
  let at = settings.panelPlace === "button" ? null
    : caret.typingPoint(source, { x: btn.x - 30, y: btn.y - 30, width: btn.width + 60, height: btn.height + 60 });
  if (at) {
    const wa = screen.getDisplayNearestPoint(at).workArea;
    let x = at.x - 24, y = at.y + (at.h || 18) + 10;          // just below the line you're typing on
    if (y + h > wa.y + wa.height) y = at.y - h - 10;           // no room below: open above it
    return clampToScreen({ x, y, width: w, height: h });
  }
  // Next to the mic button, opening towards the middle of the screen.
  const wa = screen.getDisplayMatching(btn).workArea;
  const right = btn.x + btn.width / 2 > wa.x + wa.width / 2;
  const below = btn.y + btn.height / 2 > wa.y + wa.height / 2;
  return clampToScreen({ x: right ? btn.x + btn.width - w : btn.x, y: below ? btn.y - h - 8 : btn.y + btn.height + 8, width: w, height: h });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 660, height: 840, title: "SayIt settings", autoHideMenuBar: true, backgroundColor: "#faf7f1",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  if (isMac) app.dock && app.dock.show();
  settingsWin.on("closed", () => { settingsWin = null; if (isMac) app.dock && app.dock.hide(); });
}

// ---------- "new version available" ----------
let update = null; // { version, url, auto }   auto = SayIt can install it by itself
let latestRel = null;
async function checkUpdate(manual) {
  try {
    const r = await fetch(`https://api.github.com/repos/${S.SAYIT_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "SayIt" } });
    if (!r.ok) throw new Error("status " + r.status);
    const rel = await r.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const was = update;
    latestRel = rel;
    update = latest && S.sayitNewer(latest, app.getVersion()) ? { version: latest, url: rel.html_url, auto: updater.canSelfUpdate() } : null;
    buildTray();
    if (update && (!was || was.version !== update.version) && !manual && Notification.isSupported()) {
      const n = new Notification({ title: "SayIt " + update.version + " is available", body: update.auto ? "Click to update. It takes about a minute." : "Click to download the new version." });
      n.on("click", () => (update.auto ? openSettings() : shell.openExternal(update.url))); n.show();
    }
    if (settingsWin) settingsWin.webContents.send("update", update);
    return { update, current: app.getVersion() };
  } catch (e) { return { error: "Couldn't check right now (" + e.message + ")", current: app.getVersion() }; }
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Start / stop speaking", accelerator: settings.hotkey, click: () => toggle("tray") },
    { type: "separator" },
    { label: "Show floating button", type: "checkbox", checked: settings.showBubble, click: (m) => setShowBubble(m.checked) },
    { label: "Start SayIt when computer starts", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked }) },
    { label: "Settings…", click: openSettings },
    { label: "Open log (to report a problem)", click: () => shell.openPath(path.join(app.getPath("userData"), "sayit-log.txt")) },
    update ? { label: "⬆ Update to v" + update.version + (update.auto ? " now" : " (download)"), click: () => (update.auto ? openSettings() : shell.openExternal(update.url)) }
           : { label: "Check for updates", click: () => checkUpdate(true).then(() => openSettings()) },
    { type: "separator" },
    { label: "Quit SayIt (v" + app.getVersion() + ")", click: () => app.quit() }
  ]);
}
function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", isMac ? "trayTemplate.png" : "tray.png"));
  if (isMac) icon.setTemplateImage(true);
  if (!tray) {
    tray = new Tray(icon);
    // Clicking the tray icon takes focus away from the app you're typing in, so it opens the menu
    // instead of starting to listen (otherwise your text would have nowhere to go).
    tray.on("click", () => tray.popUpContextMenu());
  }
  tray.setToolTip("SayIt: " + settings.hotkey + " to speak");
  tray.setContextMenu(trayMenu());
}

function setShowBubble(v) {
  settings.showBubble = v; saveSettings();
  if (v) button.showInactive(); else button.hide();
  buildTray();
}

// ---------- start / stop ----------
function toggle(source) {
  if (!panel) return;
  if (panelState === "idle" || panelState === "done") {
    panel.setBounds(panelBounds(source));
    panel.showInactive();
  }
  panel.webContents.send("toggle");
}

let registered = null;
function registerHotkey() {
  if (registered) { try { globalShortcut.unregister(registered); } catch {} registered = null; }
  try {
    if (globalShortcut.register(settings.hotkey, () => toggle("hotkey"))) { registered = settings.hotkey; return true; }
  } catch {}
  return false;
}
function setEscape(on) {
  try {
    if (on && !globalShortcut.isRegistered("Escape")) globalShortcut.register("Escape", () => panel.webContents.send("cancel"));
    if (!on && globalShortcut.isRegistered("Escape")) globalShortcut.unregister("Escape");
  } catch {}
}

// ---------- IPC ----------
ipcMain.handle("settings:get", () => publicSettings());
ipcMain.handle("settings:getFull", () => ({ ...settings, themeResolved: themeResolved() }));
ipcMain.handle("settings:set", (_e, patch) => {
  const oldHotkey = settings.hotkey;
  // Merge keys and models with what's already saved, so saving one provider's key never erases another's.
  const keys = patch.keys ? { ...settings.keys, ...patch.keys } : settings.keys;
  const models = patch.models ? { ...settings.models, ...patch.models } : settings.models;
  settings = { ...settings, ...patch, keys, models };
  saveSettings();
  let hotkeyOk = true;
  if (patch.hotkey && patch.hotkey !== oldHotkey) {
    hotkeyOk = registerHotkey();
    if (!hotkeyOk) { settings.hotkey = oldHotkey; saveSettings(); registerHotkey(); }
    buildTray();
  }
  if ("showBubble" in patch) setShowBubble(patch.showBubble);
  if ("bubbleSize" in patch && button) button.setBounds(buttonBounds());
  if ("panelW" in patch || "panelH" in patch) {
    if (panel && panel.isVisible()) { const b = panel.getBounds(); panel.setBounds(clampToScreen({ ...b, width: settings.panelW, height: settings.panelH })); }
  }
  broadcast();
  return { ok: true, hotkeyOk, settings: publicSettings() };
});
ipcMain.handle("transcribe", async (_e, wav, prompt) => {
  try { return { text: await core.transcribe(Buffer.from(wav), settings, prompt) }; }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle("polish", async (_e, text, mode) => {
  const t0 = Date.now();
  try { return { ...(await core.polish(text, settings, mode)), ms: Date.now() - t0 }; }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle("type", async (_e, text) => {
  try { if (TEST) await testType(text); else await typeText(text); return { ok: true }; }
  catch (e) {
    if (isMac) return { error: "mac-accessibility" };
    return { error: e.message };
  }
});
// the panel tells us what it's doing, so the button and Esc key follow along
// ---------- keep an eye on the box while you talk ----------
// If the box ever stops responding (or its page crashes), SayIt saves your words to the
// clipboard, tells you, and makes a fresh box. A note goes to the log every minute.
let panelText = "", lastPong = 0, healthTimer = null, healthTicks = 0, listenStart = 0;
ipcMain.on("panel-text", (_e, t) => { panelText = String(t || ""); });
ipcMain.on("pong", () => { lastPong = Date.now(); });
function startHealth() {
  if (healthTimer) return;
  lastPong = Date.now(); healthTicks = 0; listenStart = Date.now();
  healthTimer = setInterval(() => {
    if (!panel || panel.isDestroyed()) return;
    panel.webContents.send("ping");
    try { panel.webContents.invalidate(); } catch {} // make sure the box is redrawn
    healthTicks++;
    if (healthTicks % 20 === 0) logHealth();
    if (Date.now() - lastPong > 12000) recoverPanel("stopped responding");
  }, 3000);
}
function stopHealth() { clearInterval(healthTimer); healthTimer = null; }
function logHealth() {
  try {
    const pid = panel.webContents.getOSProcessId();
    const m = app.getAppMetrics().find((x) => x.pid === pid);
    debugLog("recording " + Math.round((Date.now() - listenStart) / 1000) + "s, words " + panelText.split(/\s+/).filter(Boolean).length +
      (m ? ", box memory " + Math.round(m.memory.workingSetSize / 1024) + " MB, cpu " + Math.round(m.cpu.percentCPUUsage) + "%" : ""));
  } catch {}
}
let recovering = false;
function recoverPanel(why) {
  if (recovering) return;
  recovering = true;
  stopHealth();
  debugLog("box " + why + " after " + Math.round((Date.now() - listenStart) / 1000) + "s; saving " + panelText.length + " characters to the clipboard");
  const saved = panelText.trim();
  if (saved) require("electron").clipboard.writeText(saved);
  try { panel.destroy(); } catch {}
  panel = null; panelState = "idle"; setEscape(false);
  if (button && !button.isDestroyed()) button.webContents.send("recording", false);
  createPanel();
  if (Notification.isSupported()) new Notification({
    title: "SayIt had a problem with the box",
    body: saved ? "Your words are safe: they're copied. Click where you want them and press " + (isMac ? "⌘V" : "Ctrl+V") + "." : "Please try again."
  }).show();
  setTimeout(() => { recovering = false; }, 2000);
}

ipcMain.on("panel-state", (_e, s) => {
  panelState = s;
  const active = s === "listening" || s === "working";
  if (active) startHealth(); else stopHealth();
  if (s === "idle") panelText = "";
  setEscape(active);
  if (button && !button.isDestroyed()) button.webContents.send("recording", s === "listening");
  if (s === "idle" && panel) panel.hide();
  else if (panel && !panel.isVisible()) { panel.setBounds(panelBounds("tray")); panel.showInactive(); }
});
// One click on the mic = one start/stop. The same click can reach us twice (from Windows
// directly and from the window), and a double-click is two clicks; both used to open the box
// and close it again at once. So clicks less than 0.6 s apart count once.
let lastButtonClick = 0;
function buttonClick(from) {
  const now = Date.now();
  if (now - lastButtonClick < 600) return;
  lastButtonClick = now;
  debugLog("click from " + from + ", box was " + panelState);
  toggle("button");
}
function dragButton(dx, dy) {
  const b = button.getBounds(), px = buttonPx(); // always the exact size, so it can't grow while dragging
  button.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: px, height: px });
}
function dragButtonEnd() {
  const px = buttonPx();
  const b = clampToScreen({ ...button.getBounds(), width: px, height: px });
  button.setBounds(b);
  settings.pos = { x: b.x, y: b.y }; saveSettings();
}
let lastMenu = 0;
function buttonMenu() {
  if (Date.now() - lastMenu < 600) return;
  lastMenu = Date.now();
  Menu.buildFromTemplate([
    { label: "Settings…", click: openSettings },
    { label: "Hide floating button", click: () => setShowBubble(false) },
    { type: "separator" },
    { label: "Quit SayIt", click: () => app.quit() }
  ]).popup({ window: button });
}
// Windows: read the mouse straight from Windows (see winmouse.js). The window's own events
// are kept only as a backup for clicks.
let nativeMouse = false;
ipcMain.handle("native-mouse", () => nativeMouse);
ipcMain.on("button-click", () => { if (!(nativeMouse && winmouse.sawPress())) buttonClick("window"); });
ipcMain.on("drag", (_e, { dx, dy }) => { if (!nativeMouse) dragButton(dx, dy); });
ipcMain.on("drag-end", () => { if (!nativeMouse) dragButtonEnd(); });
// Moving and resizing the box. The app follows the mouse itself and always sets an exact
// position AND size. (Adding up small steps made the box grow on Windows with display
// scaling, because every step rounded the size up by a pixel, and a lost "mouse up" left
// the box stuck to the mouse.)
let gesture = null, gestureTimer = null;
function panelSize() {
  return { w: Math.max(PANEL_MIN.w, settings.panelW || PANEL_DEFAULT.w), h: Math.max(PANEL_MIN.h, settings.panelH || PANEL_DEFAULT.h) };
}
function startGesture(kind) {
  if (!panel || panel.isDestroyed()) return;
  endGesture();
  const p = screen.getCursorScreenPoint(), b = panel.getBounds(), z = panelSize();
  gesture = { kind, sx: p.x, sy: p.y, x: b.x, y: b.y, w: kind === "resize" ? b.width : z.w, h: kind === "resize" ? b.height : z.h, t: Date.now() };
  gesture.cw = gesture.w; gesture.ch = gesture.h;
  gestureTimer = setInterval(stepGesture, 16);
}
function stepGesture() {
  const g = gesture;
  if (!g || !panel || panel.isDestroyed()) return endGesture();
  // Windows: stop the moment the mouse button is up, even if the box never heard about it.
  if (nativeMouse && Date.now() - g.t > 80 && !winmouse.leftDown()) return endGesture();
  if (Date.now() - g.t > 60000) return endGesture(); // safety net
  const p = screen.getCursorScreenPoint();
  const dx = p.x - g.sx, dy = p.y - g.sy;
  if (g.kind === "move") {
    panel.setBounds({ x: Math.round(g.x + dx), y: Math.round(g.y + dy), width: g.w, height: g.h });
  } else {
    g.cw = Math.max(PANEL_MIN.w, Math.round(g.w + dx)); g.ch = Math.max(PANEL_MIN.h, Math.round(g.h + dy));
    panel.setBounds({ x: g.x, y: g.y, width: g.cw, height: g.ch });
  }
}
function endGesture() {
  clearInterval(gestureTimer); gestureTimer = null;
  const g = gesture; gesture = null;
  if (!g || !panel || panel.isDestroyed()) return;
  const b = clampToScreen({ ...panel.getBounds(), width: g.cw, height: g.ch });
  panel.setBounds(b);
  if (g.kind === "move") settings.panelPos = { x: b.x, y: b.y }; // used when "where I last left it" is chosen
  else { settings.panelW = b.width; settings.panelH = b.height; }
  saveSettings();
}
ipcMain.on("panel-move-start", () => startGesture("move"));
ipcMain.on("panel-resize-start", () => startGesture("resize"));
ipcMain.on("panel-gesture-end", () => endGesture());
ipcMain.on("open-settings", openSettings);
ipcMain.handle("copy", (_e, t) => { require("electron").clipboard.writeText(String(t || "")); return true; });
ipcMain.handle("update:check", () => checkUpdate(true));
ipcMain.handle("update:get", () => ({ update, current: app.getVersion() }));
let installing = false;
ipcMain.handle("update:install", async () => {
  if (installing) return { busy: true };
  if (!latestRel || !update) { const r = await checkUpdate(true); if (!update) return { error: r.error || "You already have the latest version" }; }
  installing = true;
  const tell = (f, msg) => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("update-progress", { f, msg }); };
  try {
    debugLog("updating to v" + update.version);
    return await updater.install(latestRel, tell);
  } catch (e) {
    debugLog("update failed: " + e.message);
    return { error: "Couldn't update: " + e.message + ". You can download it instead." };
  } finally { installing = false; }
});
ipcMain.handle("panel:reset", () => {
  settings.panelW = PANEL_DEFAULT.w; settings.panelH = PANEL_DEFAULT.h; settings.panelPos = null; saveSettings();
  return true;
});
ipcMain.on("menu", () => { if (!(nativeMouse && winmouse.sawPress())) buttonMenu(); });
ipcMain.on("open-url", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle("mic-access", async () => {
  if (isMac) {
    const st = systemPreferences.getMediaAccessStatus("microphone");
    if (st === "granted") return true;
    return systemPreferences.askForMediaAccess("microphone");
  }
  return true;
});
ipcMain.handle("test-ai", async () => {
  const t0 = Date.now();
  if (!core.aiConfig(settings)) return { error: "No key for this provider yet." };
  try {
    const r = await core.polish("they was late to the meeting yesterday we start at nine", { ...settings, mode: "grammar" }, "grammar");
    return { text: r.text, ms: Date.now() - t0 };
  } catch (e) { return { error: e.message }; }
});

// ---------- test mode (only when SAYIT_TEST is set; never in normal use) ----------
const TEST = process.env.SAYIT_TEST;
if (TEST) {
  let n = 0;
  core.transcribe = async () => { await new Promise((r) => setTimeout(r, 300)); n++; return ["me and my team was going to Oyam", "the farmers was waiting for us", "we collect data from twenty farmers"][(n - 1) % 3]; };
  core.polish = async (t) => { await new Promise((r) => setTimeout(r, 400)); return { text: t.replace(/\bwas\b/g, "were").replace(/^./, (c) => c.toUpperCase()) + "." }; };
}
async function testType(text) { fs.appendFileSync(TEST, JSON.stringify({ t: Date.now(), text }) + "\n"); }
function testLog(o) { fs.appendFileSync(TEST, JSON.stringify(o) + "\n"); }

// ---------- start ----------
app.whenReady().then(() => {
  if (!gotLock) return;
  loadSettings();
  if (isMac && app.dock) app.dock.hide();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");
  createButton();
  createPanel();
  buildTray();
  caret.startTracking();
  if (isWin && !TEST) nativeMouse = winmouse.start({
    getButton: () => button, getOthers: () => [panel, settingsWin], onClick: () => buttonClick("windows"),
    onDrag: dragButton, onDragEnd: dragButtonEnd, onMenu: buttonMenu
  });
  if (nativeMouse) caret.setClickSource(winmouse.lastClick);
  debugLog("started v" + app.getVersion() + " on " + process.platform + ", direct mouse: " + nativeMouse);
  nativeTheme.on("updated", broadcast);
  if (!registerHotkey()) console.warn("SayIt: could not register", settings.hotkey);
  if (settings.firstRun && !TEST && (isWin || isMac)) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch {} // start with the computer (can be turned off in the tray menu)
  }
  if (settings.firstRun || !core.speechKey(settings) || TEST) { settings.firstRun = false; saveSettings(); openSettings(); }
  screen.on("display-removed", () => button && button.setBounds(buttonBounds()));
  if (!TEST) { setTimeout(() => checkUpdate(false), 8000); setInterval(() => checkUpdate(false), 24 * 3600 * 1000); }
  if (TEST) runTest();
});
// Opening SayIt again (Start menu, desktop shortcut, Applications) while it's running:
// bring the floating button back and show settings.
app.on("second-instance", () => {
  if (!settings.showBubble) setShowBubble(true); else if (button && !button.isVisible()) button.showInactive();
  openSettings();
});
app.on("window-all-closed", (e) => e.preventDefault && e.preventDefault()); // keep running in the tray
app.on("will-quit", () => { globalShortcut.unregisterAll(); saveSettings(true); });

// Scripted run used by the automated tests (SAYIT_TEST=logfile).
function runTest() {
  settings.keys = { groq: "test" }; settings.firstRun = false;
  if (process.env.SAYIT_SHOWCHANGES) settings.showChanges = true;
  if (process.env.SAYIT_FAKE_UPDATE) {
    update = { version: "9.9.9", url: "https://github.com/ambroseonapa/sayit/releases", auto: true };
    setTimeout(async () => { if (settingsWin) { settingsWin.webContents.send("update", update); await new Promise((r) => setTimeout(r, 300));
      await settingsWin.webContents.executeJavaScript("window.scrollTo(0,0); document.getElementById('updBar').hidden=false; document.getElementById('updFill').style.width='42%'; document.getElementById('updMsg').textContent='Downloading… 42%'");
      await new Promise((r) => setTimeout(r, 300)); settingsWin.webContents.capturePage().then((img) => fs.writeFileSync(TEST + ".update.png", img.toPNG())); } }, 4000);
  }
  for (const k of ["theme", "textSize", "bubbleSize", "panelPlace"]) if (process.env["SAYIT_" + k.toUpperCase()]) settings[k] = process.env["SAYIT_" + k.toUpperCase()];
  button.setBounds(buttonBounds()); broadcast();
  const shot = (w, name) => w.webContents.capturePage().then((img) => fs.writeFileSync(TEST + "." + name + ".png", img.toPNG()));
  const how = process.env.SAYIT_HOW || "hotkey";
  setTimeout(() => {
    if (how === "button") {
      // pretend the mouse rested in a text box at (300, 200) before moving to the button
      require("electron").screen.getCursorScreenPoint = () => ({ x: 300, y: 200 });
      setTimeout(() => { button.webContents.executeJavaScript("document.getElementById('btn').dispatchEvent(new PointerEvent('pointerdown',{button:0,screenX:5,screenY:5,bubbles:true}));document.getElementById('btn').dispatchEvent(new PointerEvent('pointermove',{screenX:9,screenY:8,bubbles:true}));document.getElementById('btn').dispatchEvent(new PointerEvent('pointerup',{screenX:9,screenY:8,bubbles:true}));"); testLog({ event: "button-click" }); if (process.env.SAYIT_DOUBLE) setTimeout(() => { button.webContents.executeJavaScript("document.getElementById('btn').dispatchEvent(new MouseEvent('click',{bubbles:true}))"); testLog({ event: "second-click" }); }, 250); }, 700);
    } else { testLog({ event: "hotkey" }); toggle("hotkey"); }
  }, 1500);
  setTimeout(() => testLog({ event: "panel", bounds: panel.getBounds(), visible: panel.isVisible(), focusable: panel.isFocusable() }), 3500);
  if (process.env.SAYIT_RESIZE) setTimeout(async () => {
    const scr = require("electron").screen; let cur = { x: 500, y: 500 }; scr.getCursorScreenPoint = () => cur;
    const ev = (id, type) => panel.webContents.executeJavaScript(`document.getElementById('${id}').dispatchEvent(new PointerEvent('${type}',{button:0,bubbles:true}))`);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = panel.getBounds();
    await ev("grip", "pointerdown"); for (let i = 1; i <= 6; i++) { cur = { x: 500 + 20 * i, y: 500 + 15 * i }; await wait(40); } await ev("grip", "pointerup"); await wait(100);
    const afterResize = panel.getBounds();
    cur = { x: 500, y: 500 };
    await ev("top", "pointerdown"); for (let i = 1; i <= 40; i++) { cur = { x: 500 - 5 * i + (i % 3), y: 500 - 2.5 * i }; await wait(20); } await ev("top", "pointerup"); await wait(100);
    testLog({ event: "after-resize-move", before, afterResize, afterMove: panel.getBounds(), saved: { w: settings.panelW, h: settings.panelH, pos: settings.panelPos }, gestureOver: !gesture });
    const clickable = await panel.webContents.executeJavaScript("(() => { const r = document.getElementById('copy').getBoundingClientRect(); const e = document.elementFromPoint(r.x + 5, r.y + 5); return e && e.id; })()");
    testLog({ event: "copy-button-on-top", clickable });
  }, 5000);
  setTimeout(() => shot(panel, "panel"), 7600);
  setTimeout(() => shot(button, "button"), 7700);
  setTimeout(async () => {
    await panel.webContents.executeJavaScript("document.getElementById('copy').click()");
    setTimeout(async () => testLog({ event: "copy", clipboard: require("electron").clipboard.readText(), label: await panel.webContents.executeJavaScript("document.getElementById('copy').textContent") }), 300);
  }, 9000);
  if (process.env.SAYIT_SHOT_KEYS) setTimeout(async () => { if (!settingsWin) return;
    await settingsWin.webContents.executeJavaScript("document.getElementById('provider').scrollIntoView(); window.scrollBy(0,-90)");
    await new Promise((r) => setTimeout(r, 300)); settingsWin.webContents.capturePage().then((img) => fs.writeFileSync(TEST + ".keys.png", img.toPNG()));
    await settingsWin.webContents.executeJavaScript("const p=document.getElementById('provider'); p.value='anthropic'; p.dispatchEvent(new Event('change'))");
    await new Promise((r) => setTimeout(r, 400)); settingsWin.webContents.capturePage().then((img) => fs.writeFileSync(TEST + ".keys2.png", img.toPNG()));
    testLog({ event: "keys", groq: !!(settings.keys || {}).groq, provider: settings.provider });
  }, 4500);
  if (process.env.SAYIT_HANG) setTimeout(() => { testLog({ event: "hang" }); panel.webContents.executeJavaScript("setTimeout(() => { for (;;) {} }, 10)"); }, 8500);
  if (process.env.SAYIT_HANG) setTimeout(() => testLog({ event: "after-hang", clipboard: require("electron").clipboard.readText(), newPanel: !!panel && !panel.isDestroyed(), state: panelState }), 26000);
  const LONG = Number(process.env.SAYIT_LONG || 0) * 1000; // long-recording test
  if (LONG) setInterval(() => { logHealth(); testLog({ event: "health", t: Math.round((Date.now() - listenStart) / 1000), words: panelText.split(/\s+/).filter(Boolean).length, metrics: app.getAppMetrics().map((m) => m.type + ":" + Math.round(m.memory.workingSetSize / 1024) + "MB/" + Math.round(m.cpu.percentCPUUsage) + "%").join(" ") }); }, 30000);
  setTimeout(() => { testLog({ event: "finish" }); toggle("hotkey"); }, 10500 + LONG);
  if (process.env.SAYIT_SHOWCHANGES) setTimeout(async () => {
    await shot(panel, "review");
    testLog({ event: "review", html: await panel.webContents.executeJavaScript("document.getElementById('text').innerHTML + ' | done=' + document.getElementById('done').textContent + ' mine.hidden=' + document.getElementById('mine').hidden") });
    await panel.webContents.executeJavaScript("document.getElementById('done').click()");
  }, 12000);
  setTimeout(() => testLog({ event: "after", panelVisible: panel.isVisible(), state: panelState }), 13500 + LONG + (LONG ? 15000 : 0));
  setTimeout(async () => { if (settingsWin) { await settingsWin.webContents.executeJavaScript("window.scrollTo(0, 99999)"); setTimeout(() => shot(settingsWin, "settings"), 300); } }, 3000);
  setTimeout(() => app.quit(), 14500 + LONG + (LONG ? 15000 : 0));
}
