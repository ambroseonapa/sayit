const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, nativeTheme, session, systemPreferences, shell, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const core = require("./core.js");
const { typeText } = require("./paste.js");
const caret = require("./caret.js");
const S = require("./shared.js");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const BUTTONS = { s: 48, m: 64, l: 84 };
const PANEL_DEFAULT = { w: 440, h: 300 };   // a bit taller than wide: easier to read
const PANEL_MIN = { w: 320, h: 190 };

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
// The shortcut doesn't count as a "click", so let audio start without one.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

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
}
let saveTimer = null;
function saveSettings(now) {
  clearTimeout(saveTimer);
  const write = () => { try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.warn(e); } };
  if (now) write(); else saveTimer = setTimeout(write, 300);
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
let update = null; // { version, url }
async function checkUpdate(manual) {
  try {
    const r = await fetch(`https://api.github.com/repos/${S.SAYIT_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "SayIt" } });
    if (!r.ok) throw new Error("status " + r.status);
    const rel = await r.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const was = update;
    update = latest && S.sayitNewer(latest, app.getVersion()) ? { version: latest, url: rel.html_url } : null;
    buildTray();
    if (update && (!was || was.version !== update.version) && !manual && Notification.isSupported()) {
      const n = new Notification({ title: "SayIt " + update.version + " is available", body: "Click to download the new version." });
      n.on("click", () => shell.openExternal(update.url)); n.show();
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
    update ? { label: "⬆ Update available: v" + update.version + " (download)", click: () => shell.openExternal(update.url) }
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
ipcMain.on("panel-state", (_e, s) => {
  panelState = s;
  const active = s === "listening" || s === "working";
  setEscape(active);
  if (button && !button.isDestroyed()) button.webContents.send("recording", s === "listening");
  if (s === "idle" && panel) panel.hide();
  else if (panel && !panel.isVisible()) { panel.setBounds(panelBounds("tray")); panel.showInactive(); }
});
ipcMain.on("button-click", () => toggle("button"));
ipcMain.on("drag", (_e, { dx, dy }) => {
  const b = button.getBounds();
  button.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
});
ipcMain.on("drag-end", () => {
  const b = clampToScreen(button.getBounds());
  button.setBounds(b);
  settings.pos = { x: b.x, y: b.y }; saveSettings();
});
ipcMain.on("panel-move", (_e, { dx, dy }) => {
  const b = panel.getBounds();
  panel.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
});
ipcMain.on("panel-move-end", () => {
  const b = clampToScreen(panel.getBounds());
  panel.setBounds(b);
  settings.panelPos = { x: b.x, y: b.y }; saveSettings(); // used when "where I last left it" is chosen
});
ipcMain.on("panel-resize", (_e, { dx, dy }) => {
  const b = panel.getBounds();
  panel.setBounds({ ...b, width: Math.max(PANEL_MIN.w, b.width + dx), height: Math.max(PANEL_MIN.h, b.height + dy) });
});
ipcMain.on("panel-resize-end", () => {
  const b = clampToScreen(panel.getBounds());
  panel.setBounds(b);
  settings.panelW = b.width; settings.panelH = b.height; saveSettings();
});
ipcMain.on("open-settings", openSettings);
ipcMain.handle("update:check", () => checkUpdate(true));
ipcMain.handle("update:get", () => ({ update, current: app.getVersion() }));
ipcMain.handle("panel:reset", () => {
  settings.panelW = PANEL_DEFAULT.w; settings.panelH = PANEL_DEFAULT.h; settings.panelPos = null; saveSettings();
  return true;
});
ipcMain.on("menu", () => {
  Menu.buildFromTemplate([
    { label: "Settings…", click: openSettings },
    { label: "Hide floating button", click: () => setShowBubble(false) },
    { type: "separator" },
    { label: "Quit SayIt", click: () => app.quit() }
  ]).popup({ window: button });
});
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
  for (const k of ["theme", "textSize", "bubbleSize", "panelPlace"]) if (process.env["SAYIT_" + k.toUpperCase()]) settings[k] = process.env["SAYIT_" + k.toUpperCase()];
  button.setBounds(buttonBounds()); broadcast();
  const shot = (w, name) => w.webContents.capturePage().then((img) => fs.writeFileSync(TEST + "." + name + ".png", img.toPNG()));
  const how = process.env.SAYIT_HOW || "hotkey";
  setTimeout(() => {
    if (how === "button") {
      // pretend the mouse rested in a text box at (300, 200) before moving to the button
      require("electron").screen.getCursorScreenPoint = () => ({ x: 300, y: 200 });
      setTimeout(() => { button.webContents.executeJavaScript("document.getElementById('btn').dispatchEvent(new PointerEvent('pointerdown',{button:0,screenX:5,screenY:5,bubbles:true}));document.getElementById('btn').dispatchEvent(new PointerEvent('pointermove',{screenX:9,screenY:8,bubbles:true}));document.getElementById('btn').dispatchEvent(new PointerEvent('pointerup',{screenX:9,screenY:8,bubbles:true}));"); testLog({ event: "button-click" }); }, 700);
    } else { testLog({ event: "hotkey" }); toggle("hotkey"); }
  }, 1500);
  setTimeout(() => testLog({ event: "panel", bounds: panel.getBounds(), visible: panel.isVisible(), focusable: panel.isFocusable() }), 3500);
  if (process.env.SAYIT_RESIZE) setTimeout(async () => {
    const ev = (id, type, x, y) => `document.getElementById('${id}').dispatchEvent(new PointerEvent('${type}',{button:0,screenX:${x},screenY:${y},bubbles:true}));`;
    await panel.webContents.executeJavaScript(ev("grip","pointerdown",0,0) + ev("grip","pointermove",120,90) + ev("grip","pointerup",120,90));
    await new Promise((r) => setTimeout(r, 300));
    await panel.webContents.executeJavaScript(ev("top","pointerdown",0,0) + ev("top","pointermove",-200,-100) + ev("top","pointerup",-200,-100));
    await new Promise((r) => setTimeout(r, 300));
    testLog({ event: "after-resize-move", bounds: panel.getBounds(), saved: { w: settings.panelW, h: settings.panelH, pos: settings.panelPos }, button: button.getBounds() });
  }, 5000);
  setTimeout(() => shot(panel, "panel"), 7600);
  setTimeout(() => shot(button, "button"), 7700);
  setTimeout(() => { testLog({ event: "finish" }); toggle("hotkey"); }, 10500);
  setTimeout(() => testLog({ event: "after", panelVisible: panel.isVisible(), state: panelState }), 13500);
  setTimeout(async () => { if (settingsWin) { await settingsWin.webContents.executeJavaScript("window.scrollTo(0, 99999)"); setTimeout(() => shot(settingsWin, "settings"), 300); } }, 3000);
  setTimeout(() => app.quit(), 14500);
}
