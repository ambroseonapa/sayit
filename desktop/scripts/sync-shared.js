// The extension and the desktop app share one file of logic (prompts, providers, helpers).
// It lives in extension/shared.js; this copies it into the desktop app before running or building.
const fs = require("fs");
const path = require("path");
const from = path.join(__dirname, "..", "..", "extension", "shared.js");
const to = path.join(__dirname, "..", "src", "shared.js");
if (fs.existsSync(from)) { fs.copyFileSync(from, to); console.log("shared.js synced from extension/"); }
