const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sayit", {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getFullSettings: () => ipcRenderer.invoke("settings:getFull"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  transcribe: (wav, prompt) => ipcRenderer.invoke("transcribe", wav, prompt),
  polish: (text, mode) => ipcRenderer.invoke("polish", text, mode),
  type: (text) => ipcRenderer.invoke("type", text),
  micAccess: () => ipcRenderer.invoke("mic-access"),
  testAI: () => ipcRenderer.invoke("test-ai"),
  buttonClick: () => ipcRenderer.send("button-click"),
  panelState: (s) => ipcRenderer.send("panel-state", s),
  panelMove: (dx, dy) => ipcRenderer.send("panel-move", { dx, dy }),
  panelMoveEnd: () => ipcRenderer.send("panel-move-end"),
  panelResize: (dx, dy) => ipcRenderer.send("panel-resize", { dx, dy }),
  panelResizeEnd: () => ipcRenderer.send("panel-resize-end"),
  resetPanel: () => ipcRenderer.invoke("panel:reset"),
  copy: (t) => ipcRenderer.invoke("copy", t),
  drag: (dx, dy) => ipcRenderer.send("drag", { dx, dy }),
  dragEnd: () => ipcRenderer.send("drag-end"),
  openSettings: () => ipcRenderer.send("open-settings"),
  menu: () => ipcRenderer.send("menu"),
  openUrl: (u) => ipcRenderer.send("open-url", u),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  getUpdate: () => ipcRenderer.invoke("update:get"),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, ...a) => fn(...a))
});
