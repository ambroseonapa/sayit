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
  expand: (on) => ipcRenderer.send("expand", on),
  drag: (dx, dy) => ipcRenderer.send("drag", { dx, dy }),
  dragEnd: () => ipcRenderer.send("drag-end"),
  openSettings: () => ipcRenderer.send("open-settings"),
  menu: () => ipcRenderer.send("menu"),
  openUrl: (u) => ipcRenderer.send("open-url", u),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  getUpdate: () => ipcRenderer.invoke("update:get"),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, ...a) => fn(...a))
});
