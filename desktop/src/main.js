const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, session, systemPreferences, shell, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const core = require("./core.js");
const { typeText } = require("./paste.js");
const S = require("./shared.js");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
// Sizes you can choose in settings (and with A− / A+ on the panel).
const BUBBLES = { s: 48, m: 64, l: 84 };
const PANELS = { m: { w: 520, h: 200 }, l: { w: 580, h: 240 }, xl: { w: 700, h: 300 } };
const bubblePx = () => BUBBLES[settings.bubbleSize] || BUBBLES.m;
const panelSz = () => PANELS[settings.panelSize] || PANELS.l;

if (!app.requestSingleInstanceLock()) { app.quit(); }
// The shortcut doesn't count as a "click", so let audio start without one.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// ---------- settings ----------
const DEFAULTS = {
  ...S.SAYIT_DEFAULTS,
  engine: "ai", provider: "groq", keys: {}, models: {}, customUrl: "",
  hotkey: "Alt+Shift+D", showBubble: true, pos: null, firstRun: true,
  bubbleSize: "m", panelSize: "l"
};
let settingsFile, settings;
function loadSettings() {
  settingsFile = path.join(app.getPath("userData"), "settings.json");
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, "utf8")) }; }
  catch { settings = { ...DEFAULTS }; }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.warn(e); }
}
const publicSettings = () => { const { keys, ...rest } = settings; return { ...rest, hasKey: !!(keys && (keys.groq || keys.openai)) }; };

// ---------- windows ----------
let bubble = null, settingsWin = null, tray = null, expanded = false;

function bubbleBounds(exp) {
  const BUBBLE = bubblePx(), PANEL = panelSz();
  const wa = screen.getDisplayNearestPoint(settings.pos || screen.getCursorScreenPoint()).workArea;
  // pos = where the round button sits (top-left of the 64x64 square)
  let p = settings.pos || { x: wa.x + wa.width - BUBBLE - 24, y: wa.y + wa.height - BUBBLE - 120 };
  p = { x: Math.min(Math.max(p.x, wa.x), wa.x + wa.width - BUBBLE), y: Math.min(Math.max(p.y, wa.y), wa.y + wa.height - BUBBLE) };
  if (!exp) return { x: p.x, y: p.y, width: BUBBLE, height: BUBBLE };
  // The panel grows out of the button, towards the middle of the screen.
  const right = p.x + BUBBLE / 2 > wa.x + wa.width / 2;
  const below = p.y + BUBBLE / 2 > wa.y + wa.height / 2;
  let x = right ? p.x + BUBBLE - PANEL.w : p.x;
  let y = below ? p.y + BUBBLE - PANEL.h : p.y;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - PANEL.w);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - PANEL.h);
  return { x, y, width: PANEL.w, height: PANEL.h };
}

function createBubble() {
  bubble = new BrowserWindow({
    ...bubbleBounds(false),
    frame: false, transparent: true, resizable: false, movable: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false,
    // The key trick: clicking SayIt must NOT take the cursor away from the app you're typing in.
    focusable: !isWin && !isMac ? true : !isWin,
    ...(isMac ? { type: "panel", hiddenInMissionControl: true } : {}),
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false }
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  if (isMac) bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubble.loadFile(path.join(__dirname, "bubble.html"));
  if (process.env.SAYIT_TEST) bubble.webContents.on("console-message", (...a) => { const e = a[0] && a[0].message ? a[0] : { message: a[2] }; fs.appendFileSync(process.env.SAYIT_TEST, JSON.stringify({ console: e.message }) + "\n"); });
  bubble.once("ready-to-show", () => { if (settings.showBubble) bubble.showInactive(); });
}

function setExpanded(exp) {
  expanded = exp;
  if (!bubble) return;
  bubble.setBounds(bubbleBounds(exp));
  if (exp && !bubble.isVisible()) bubble.showInactive();
  if (!exp && !settings.showBubble) bubble.hide();
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 640, height: 820, title: "SayIt settings", autoHideMenuBar: true, backgroundColor: "#faf7f1",
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

function buildTray() {
  const icon = isMac
    ? nativeImage.createFromPath(path.join(__dirname, "..", "assets", "trayTemplate.png"))
    : nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray.png"));
  if (isMac) icon.setTemplateImage(true);
  if (!tray) { tray = new Tray(icon); tray.setToolTip("SayIt: " + settings.hotkey + " to speak"); tray.on("click", () => !isMac && toggle()); }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Start / stop speaking", accelerator: settings.hotkey, click: toggle },
    { type: "separator" },
    { label: "Show floating button", type: "checkbox", checked: settings.showBubble, click: (m) => setShowBubble(m.checked) },
    { label: "Start SayIt when computer starts", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked }) },
    { label: "Settings…", click: openSettings },
    update ? { label: "⬆ Update available: v" + update.version + " (download)", click: () => shell.openExternal(update.url) }
           : { label: "Check for updates", click: () => checkUpdate(true).then(() => openSettings()) },
    { type: "separator" },
    { label: "Quit SayIt (v" + app.getVersion() + ")", click: () => app.quit() }
  ]));
}

function setShowBubble(v) {
  settings.showBubble = v; saveSettings();
  if (v) bubble.showInactive(); else if (!expanded) bubble.hide();
  buildTray();
}

// ---------- shortcut ----------
let registered = null;
function registerHotkey() {
  if (registered) { try { globalShortcut.unregister(registered); } catch {} registered = null; }
  try {
    if (globalShortcut.register(settings.hotkey, toggle)) { registered = settings.hotkey; return true; }
  } catch {}
  return false;
}
function toggle() { if (bubble) bubble.webContents.send("toggle"); }
function setEscape(on) {
  try {
    if (on && !globalShortcut.isRegistered("Escape")) globalShortcut.register("Escape", () => bubble.webContents.send("cancel"));
    if (!on && globalShortcut.isRegistered("Escape")) globalShortcut.unregister("Escape");
  } catch {}
}

// ---------- IPC ----------
ipcMain.handle("settings:get", () => publicSettings());
ipcMain.handle("settings:getFull", () => settings);
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
  if (("bubbleSize" in patch || "panelSize" in patch) && bubble) bubble.setBounds(bubbleBounds(expanded));
  if (bubble) bubble.webContents.send("settings", publicSettings());
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
ipcMain.on("expand", (_e, exp) => { setExpanded(exp); setEscape(exp); });
ipcMain.on("drag", (_e, { dx, dy }) => {
  const b = bubble.getBounds();
  bubble.setBounds({ ...b, x: b.x + dx, y: b.y + dy });
});
ipcMain.on("drag-end", () => {
  if (expanded) return;
  const b = bubble.getBounds();
  settings.pos = { x: b.x, y: b.y }; saveSettings();
});
ipcMain.on("open-settings", openSettings);
ipcMain.handle("update:check", () => checkUpdate(true));
ipcMain.handle("update:get", () => ({ update, current: app.getVersion() }));
ipcMain.on("menu", () => {
  Menu.buildFromTemplate([
    { label: "Settings…", click: openSettings },
    { label: "Hide floating button", click: () => setShowBubble(false) },
    { type: "separator" },
    { label: "Quit SayIt", click: () => app.quit() }
  ]).popup({ window: bubble });
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
  try {
    const r = await core.polish("they was late to the meeting yesterday we start at nine", { ...settings, mode: "grammar" }, "grammar");
    if (!core.aiConfig(settings)) return { error: "No key for this provider yet." };
    return { text: r.text, ms: Date.now() - t0 };
  } catch (e) { return { error: e.message }; }
});

// ---------- test mode (only when SAYIT_TEST is set; never in normal use) ----------
const TEST = process.env.SAYIT_TEST;
if (TEST) {
  let n = 0;
  core.transcribe = async (wav) => { await new Promise((r) => setTimeout(r, 300)); n++; return ["me and my team was going to Oyam", "the farmers was waiting for us", "we collect data from twenty farmers"][(n - 1) % 3]; };
  core.polish = async (t) => { await new Promise((r) => setTimeout(r, 400)); return { text: t.replace(/\bwas\b/g, "were").replace(/\bcollect\b/, "collected").replace(/(\w)( the| we)/g, "$1.$2").replace(/^./, (c) => c.toUpperCase()) + "." }; };
  require("./paste.js").typeText = undefined;
}
async function testType(text) { fs.appendFileSync(TEST, JSON.stringify({ t: Date.now(), text }) + "\n"); }

// ---------- start ----------
app.whenReady().then(() => {
  loadSettings();
  if (isMac && app.dock) app.dock.hide();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media");
  createBubble();
  buildTray();
  if (!registerHotkey()) console.warn("SayIt: could not register", settings.hotkey);
  const hasKey = settings.keys && (settings.keys.groq || settings.keys.openai);
  if (settings.firstRun && !TEST && (isWin || isMac)) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch {} // start with the computer (can be turned off in the tray menu)
  }
  if (settings.firstRun || !hasKey || TEST) { settings.firstRun = false; saveSettings(); openSettings(); }
  screen.on("display-removed", () => setExpanded(expanded));
  if (!process.env.SAYIT_TEST) { setTimeout(() => checkUpdate(false), 8000); setInterval(() => checkUpdate(false), 24 * 3600 * 1000); }
  if (TEST) {
    settings.keys = { groq: "test" }; settings.firstRun = false; if (process.env.SAYIT_PANEL) settings.panelSize = process.env.SAYIT_PANEL; if (process.env.SAYIT_BUBBLE) settings.bubbleSize = process.env.SAYIT_BUBBLE; bubble.setBounds(bubbleBounds(false)); bubble.webContents.send("settings", publicSettings());
    setTimeout(() => { fs.appendFileSync(TEST, JSON.stringify({ t: Date.now(), event: "toggle-start" }) + "\n"); toggle(); }, 1500);
    setTimeout(async () => { await bubble.webContents.capturePage().then((img) => fs.writeFileSync(TEST + ".panel.png", img.toPNG())); }, 7600);
    setTimeout(() => { fs.appendFileSync(TEST, JSON.stringify({ t: Date.now(), event: "toggle-finish", bounds: bubble.getBounds(), focusable: bubble.isFocusable() }) + "\n"); toggle(); }, 10500);
    setTimeout(async () => { await bubble.webContents.capturePage().then((img) => fs.writeFileSync(TEST + ".bubble.png", img.toPNG())); }, 13000);
    setTimeout(async () => { if (settingsWin) { const v = await settingsWin.webContents.executeJavaScript(`JSON.stringify({ver: document.getElementById("ver").textContent, bubble: document.querySelector("input[name=bubbleSize]:checked")?.value, panel: document.querySelector("input[name=panelSize]:checked")?.value, tone: document.getElementById("tone").value, fillers: document.getElementById("fillers").checked})`); fs.appendFileSync(TEST, JSON.stringify({ settingsPage: JSON.parse(v) }) + "\n"); settingsWin.webContents.executeJavaScript("window.scrollTo(0, 1500)"); } }, 2600);
    setTimeout(() => { if (settingsWin) settingsWin.webContents.capturePage().then((img) => fs.writeFileSync(TEST + ".settings.png", img.toPNG())); }, 3000);
    setTimeout(() => app.quit(), 15000);
  }
});
// Opening SayIt again (Start menu, desktop shortcut, Applications) while it's running:
// bring the floating button back and show settings.
app.on("second-instance", () => {
  if (!settings.showBubble) setShowBubble(true); else if (bubble && !bubble.isVisible()) bubble.showInactive();
  openSettings();
});
app.on("window-all-closed", (e) => e.preventDefault && e.preventDefault()); // keep running in the tray
app.on("will-quit", () => globalShortcut.unregisterAll());
