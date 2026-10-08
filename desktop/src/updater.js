// "Update now": download the new version from GitHub and install it over this one,
// without the person having to download and install anything by hand.
//   Windows (installed with SayIt-Setup-Windows.exe): run the new installer quietly; it closes
//     SayIt, installs, and opens SayIt again. Keys and settings stay.
//   Mac: download the new app, swap it in place of this one, and open it again.
//   Windows portable (zip): can't replace itself, so we open the download page instead.
const { app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile } = require("child_process");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// Which file from the release fits this computer, or null if SayIt can't update itself here.
function assetName() {
  if (isWin) return installedWithSetup() ? "SayIt-Setup-Windows.exe" : null;
  if (isMac) return process.arch === "arm64" ? "SayIt-Mac-AppleSilicon.zip" : "SayIt-Mac-Intel.zip";
  return null;
}
// The installer leaves an uninstaller next to SayIt.exe; the portable zip doesn't have one.
function installedWithSetup() {
  try { return fs.readdirSync(path.dirname(process.execPath)).some((f) => /^Uninstall .*\.exe$/i.test(f)); } catch { return false; }
}
function macBundle() { return path.resolve(process.execPath, "..", "..", ".."); } // …/SayIt.app

function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (isMac) { try { fs.accessSync(path.dirname(macBundle()), fs.constants.W_OK); return true; } catch { return false; } }
  return !!assetName();
}

// Download with progress (0..1). GitHub sends us on to its file server; fetch follows that.
async function download(url, file, onProgress) {
  const r = await fetch(url, { headers: { "user-agent": "SayIt" } });
  if (!r.ok || !r.body) throw new Error("download failed (" + r.status + ")");
  const total = Number(r.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(file);
  let got = 0, last = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((res) => out.once("drain", res));
    if (total && onProgress && Date.now() - last > 200) { last = Date.now(); onProgress(got / total); }
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  if (total && got < total) throw new Error("download was cut off, try again");
  if (onProgress) onProgress(1);
  return file;
}

// rel = the GitHub release JSON. onProgress(fraction, message).
async function install(rel, onProgress) {
  const name = assetName();
  const asset = name && (rel.assets || []).find((a) => a.name === name);
  if (!canSelfUpdate() || !asset) { shell.openExternal(rel.html_url); return { opened: true }; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sayit-update-"));
  const file = path.join(dir, name);
  await download(asset.browser_download_url, file, (f) => onProgress(f, "Downloading… " + Math.round(f * 100) + "%"));

  if (isWin) {
    onProgress(1, "Installing… SayIt will open again by itself.");
    // /S = quiet install; --force-run = open SayIt when done.
    const child = spawn(file, ["/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    setTimeout(() => app.quit(), 800);
    return { ok: true };
  }

  // Mac: unzip next to the download, then a tiny script waits for SayIt to close, swaps the
  // app and opens it again.
  onProgress(1, "Installing… SayIt will open again by itself.");
  const unz = path.join(dir, "new");
  fs.mkdirSync(unz);
  await new Promise((res, rej) => execFile("/usr/bin/ditto", ["-x", "-k", file, unz], (e) => (e ? rej(new Error("couldn't unpack the update")) : res())));
  const fresh = path.join(unz, "SayIt.app");
  if (!fs.existsSync(fresh)) throw new Error("the update looks broken, try again later");
  const target = macBundle();
  const script = path.join(dir, "swap.sh");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf "${target}.old"`,
    `mv "${target}" "${target}.old" && mv "${fresh}" "${target}" && rm -rf "${target}.old" || mv "${target}.old" "${target}"`,
    `xattr -dr com.apple.quarantine "${target}" 2>/dev/null`,
    `open "${target}"`,
    `rm -rf "${dir}"`
  ].join("\n"));
  fs.chmodSync(script, 0o755);
  spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => app.quit(), 500);
  return { ok: true };
}

module.exports = { install, canSelfUpdate, assetName, download };
