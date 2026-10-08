<p align="center"><img src="docs/images/icon.png" width="84" alt="SayIt"></p>

<h1 align="center">SayIt</h1>
<p align="center"><b>Speak, and your words are typed for you, with the grammar fixed.</b><br>
It never rewrites what you said unless you ask it to.</p>

<p align="center">
  <a href="https://github.com/ambroseonapa/sayit/releases/latest"><b>⬇ Download the latest version</b></a>
</p>

![SayIt listening in Chrome](docs/images/extension-listening.png)

Some boxes need a lot of typing: application forms, emails, comments, reports. SayIt lets you talk instead. Click in the box, tap the mic, speak, and press **Done**. Your words appear in the box with full stops, commas, capital letters and grammar fixed. Your own words stay. Nothing gets "improved" behind your back.

## Two ways to use it

| | **Chrome extension** | **Desktop app** |
|---|---|---|
| Works in | Any website in Chrome (forms, Gmail, Google Docs, LinkedIn…) | **Any app** on Windows or Mac (Word, WhatsApp, Outlook, Notepad…) |
| How you start it | Mic icon in the toolbar, or `Alt+Shift+S` | Floating mic button, or `Alt+Shift+D` |
| Words appear | Live, as you speak | Each time you pause |
| Download | [SayIt-Chrome-extension.zip][ext] | Windows: [installer][win] · [portable zip][winzip]<br>Mac: [Apple Silicon (M1–M4)][macarm] · [Intel][macintel] |

You can use both. They share the same settings ideas and the same free key.

[ext]: https://github.com/ambroseonapa/sayit/releases/latest/download/SayIt-Chrome-extension.zip
[win]: https://github.com/ambroseonapa/sayit/releases/latest/download/SayIt-Setup-Windows.exe
[winzip]: https://github.com/ambroseonapa/sayit/releases/latest/download/SayIt-Windows-portable.zip
[macarm]: https://github.com/ambroseonapa/sayit/releases/latest/download/SayIt-Mac-AppleSilicon.zip
[macintel]: https://github.com/ambroseonapa/sayit/releases/latest/download/SayIt-Mac-Intel.zip

---

## Step 1: Get a free Groq key (5 minutes)

SayIt uses AI to fix grammar (and, in the desktop app, to turn your voice into text). [Groq](https://console.groq.com) gives a free key with no card needed.

1. Go to **[console.groq.com/keys](https://console.groq.com/keys)** and sign in with Google.
2. Click **Create API key**, give it any name, and copy the key (it starts with `gsk_`).
3. Paste it into SayIt's settings (below). Keep it private, like a password.

> The Chrome extension also works **without** a key in a basic free mode, but the grammar fixing is much weaker. With a key you get proper full stops, commas and grammar.

## Step 2: Install

### Chrome extension

1. Download **[SayIt-Chrome-extension.zip][ext]** and unzip it into a folder you will keep, for example `Documents\SayIt-extension`. (Don't delete this folder; Chrome runs SayIt from it.)
2. In Chrome, open **`chrome://extensions`** and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder you unzipped (the one with `manifest.json` inside).
4. Click the puzzle-piece icon in Chrome's toolbar and **pin** SayIt.
5. The settings page opens. Under **How grammar gets fixed**, choose **AI**, keep **Groq**, paste your key and press **Test speed**.

Also works in Microsoft Edge (`edge://extensions`). Brave blocks the speech service Chrome uses, so in Brave choose **Most accurate (Whisper)** under Speech.

### Windows desktop app

1. Download **[SayIt-Setup-Windows.exe][win]** and double-click it.
2. Windows may say **"Windows protected your PC"**, because SayIt isn't signed with a paid certificate yet. Click **More info → Run anyway**. You only do this once.
3. SayIt installs and opens its settings. Paste your Groq key and press **Test**.
4. A round mic button now floats on your screen, and SayIt sits in the tray near the clock. Right-click the tray icon → **Start SayIt when computer starts** to keep it always on.

Prefer not to install? Use the **[portable zip][winzip]**: unzip it anywhere and run `SayIt.exe`.

### Mac desktop app

1. Download the right one: **[Apple Silicon (M1–M4)][macarm]** or **[Intel][macintel]** (Apple menu → About This Mac tells you which).
2. Unzip it and drag **SayIt.app** into **Applications**.
3. Because SayIt isn't signed by Apple yet, open **Terminal** once and paste:
   ```
   xattr -cr /Applications/SayIt.app
   ```
4. Open SayIt. Allow the **microphone** when asked, then paste your Groq key in settings.
5. The first time SayIt types for you, macOS asks for **Accessibility** permission. Go to **System Settings → Privacy & Security → Accessibility** and switch SayIt on. (Until then, SayIt copies your text so you can press `⌘V`.)
6. SayIt lives in the menu bar at the top of the screen.

---

## How to use it

1. **Click where you want to type**: a form box, an email, a document.
2. **Start**: Chrome: tap the SayIt icon or press `Alt+Shift+S`. Desktop: click the floating mic or press `Alt+Shift+D` (`Option+Shift+D` on Mac).
3. **Speak normally.** You can say *"comma"*, *"full stop"*, *"question mark"*, *"new line"* or *"new paragraph"* if you want, but with an AI key you don't have to.
4. **Finish**: press **Done** or the shortcut again. Your text goes into the box. **Esc** cancels.
5. **Changed your mind?** In Chrome a small pill appears for 3 seconds: **Original** puts back your exact words, **↶ Undo** removes it. `Ctrl+Z` (`⌘Z`) also works everywhere.

There is no time limit. Talk for as long as you like; if the internet drops for a moment, SayIt reconnects and keeps listening.

| The desktop mic button | The desktop app while you speak |
|---|---|
| ![](docs/images/desktop-button.png) | ![](docs/images/desktop-listening.png) |

---

## Settings explained

**What should happen to your words?**
- **Exact words**: types exactly what you said.
- **Fix grammar** (recommended): full stops, commas, capitals, question marks and grammar mistakes (*they was → they were*). It never swaps your words for "better" ones or changes your meaning. If the AI ever changes too much, SayIt keeps your original.
- **Rephrase**: rewrites it to read smoothly: removes rambling and repetition, keeps every fact. Pick a style: **Natural**, **Formal** (applications, reports), **Friendly** or **Short and clear**.
- **Remove "um", "uh" and stutters**: *"um so I I I think"* → *"so I think"*. Real words are never removed.

**Speech (Chrome extension)**
- **Instant**: Chrome's own speech recognition. Words appear as you speak.
- **Most accurate (Whisper)**: better with accents, names and fast speech. Adds about 1–2 seconds after Done. Uses your Groq key.
- **On this computer**: works without internet, usually less accurate.

**Names and words SayIt should know**: add names and local words (for example *Okidi, Oyam, Makerere*) so they are always spelled right.

**Size**
- Chrome: the listening box comes in Medium, Large and Extra large; use **A− / A+** on the box any time.
- Desktop: choose the size of the **mic button** (Small, Medium, Large) and of the **text box** (Medium, Large, Extra large), or use **A− / A+** on the box.

**Other AI providers**: Groq is the default because it is fast and free, but you can use Google Gemini (free key from AI Studio), OpenAI, Anthropic Claude, OpenRouter, or any OpenAI-compatible service.

**Finish by itself**: optionally stop after 2, 3 or 5 seconds of silence, so you don't need to press Done.

---

## Keeping SayIt up to date

SayIt checks GitHub once a day for a new version. When there is one:
- **Chrome**: the toolbar icon shows a green **new** badge, and the settings page shows a download link.
- **Desktop**: you get a notification, and the tray menu shows **Update available**.

**To update the Chrome extension:** download the new `SayIt-Chrome-extension.zip`, unzip it **over the files in your existing SayIt folder** (replace them), then go to `chrome://extensions` and click the **reload ↻** arrow on SayIt. Your key and settings stay. Reload any open tabs you want to use it in.

**To update the desktop app:** download and run the new installer (Windows) or replace SayIt.app in Applications (Mac, then run the `xattr` line again). Your key and settings stay.

You can also check by hand: Chrome settings page → **Check for updates** (bottom), or desktop tray menu → **Check for updates**.

---

## Privacy: where your voice and text go

SayIt has no server of its own and collects nothing about you. Your keys are stored only on your computer.

| What | Goes to |
|---|---|
| Your voice, Chrome **Instant** speech | Google's speech service (built into Chrome) |
| Your voice, **Most accurate** / desktop app | Groq (or OpenAI, if that's the key you use) |
| Your voice, **On this computer** | Nowhere, it stays on your computer |
| Your text, for grammar fixing | The AI provider you chose (Groq by default), or LanguageTool in free mode |
| Update check | GitHub, once a day (just asks for the latest version number) |

Don't dictate passwords or anything you wouldn't send to these services.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Microphone is blocked" | Click the icon on the left of the address bar → allow **Microphone**. On a Mac desktop app: System Settings → Privacy & Security → Microphone → SayIt on. |
| Nothing happens when I tap the icon | Click inside a text box first. SayIt can't run on `chrome://` pages or the Chrome Web Store. |
| "API key was rejected" | Paste the key again (no spaces) and press Test. Create a new key on Groq if needed. |
| "Free limit reached" | Groq's free plan has a per-minute limit. Wait a minute. |
| Google Docs | Supported. If Docs refuses the text, SayIt copies it so you can press `Ctrl+V`. |
| Desktop app types into the wrong place | Click in the box you want first, then use the shortcut instead of the button. |
| Windows: some apps don't receive the text | Apps running "as administrator" block other apps from typing into them. Run SayIt as administrator too, or use a normal window. |
| Mac: text is copied but not typed | Turn SayIt on under System Settings → Privacy & Security → **Accessibility**. |

---

## For developers

```
extension/   Chrome extension (Manifest V3). Load this folder unpacked to develop.
desktop/     Desktop app (Electron) for Windows and Mac.
docs/        Screenshots for this page.
.github/     The build that creates the downloads for each release.
```

`extension/shared.js` holds the logic both apps share (AI instructions, providers, helpers). The desktop app copies it in automatically before running or building.

**Run the desktop app from source** (needs [Node.js](https://nodejs.org) 20+):
```
cd desktop
npm install
npm start
```

**Release a new version**
1. Change the version in **both** `extension/manifest.json` and `desktop/package.json` (for example `0.6.0`).
2. Commit and push.
3. On GitHub: **Releases → Draft a new release**, create the tag `v0.6.0`, and **Publish**.
4. GitHub Actions builds the Chrome zip, the Windows installer and both Mac apps (about 10 minutes) and attaches them to the release. Everyone's SayIt will then see the update.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.
