# Changelog

## 0.8.4
**Desktop app**
- Clearer update message: "Check for updates" now says which version you have, and that an **Update now** button appears at the top of settings when a new version is out. If there is one, the page scrolls up to it.
- This is also the first version you can get with **Update now** from 0.8.3.

## 0.8.3
**Desktop app**
- **Update now**: when a new version is out, press **Update now** in SayIt settings (or in the tray / menu-bar menu). SayIt downloads it, installs it and opens again by itself. No more downloading and installing by hand. (The Windows portable zip opens the download page instead.)

**Chrome extension**
- **Move and resize the box**: drag its top row to move it, and its bottom-right corner to resize it. SayIt remembers where you put it and how big. A− / A+ still changes the size. Settings → Look of the listening box → *Put the box back at the bottom* undoes it.

**Both**
- SayIt is now open source under the **MIT License**.

## 0.8.2
**Desktop app**
- Fixed: **dragging the box made it bigger and bigger** (Windows with display scaling of 125% or 150%). The box now keeps its exact size when you move it. If your box had grown too big, it is set back to the normal size once.
- Fixed: after dragging, the box could **freeze**: Copy, the mode button and dragging stopped responding until SayIt was restarted.
- Resizing from the edges of the box is now remembered too. The default box is a little smaller (a wide square).
- **Scroll back while you talk**: if you scroll up to read what you said, the box stays there instead of jumping back to the newest words. Scroll to the bottom and it follows again.
- **The box opens where you clicked to type** (Windows), also in Chrome, Edge and other apps that don't show their text cursor to SayIt.

**Both**
- Fixed: Polish, Rephrase or Fix grammar could type the AI's *comment* into your document (for example "I can't rewrite this dictation because…"). SayIt now spots that, asks again, and if it still happens it inserts your own words.
- Less "ghost" text from background noise: humming like "MMMM", the same phrase repeated over and over, and names from your word list that you didn't say (such as "TAL Youth Uganda TAL Youth Uganda") are removed.

## 0.8.1
**Desktop app (Windows)**
- Fixed: **clicking the floating mic did nothing** on some Windows computers; only `Alt+Shift+D` opened the box. SayIt now reads the mouse straight from Windows, so one click opens the box and starts listening. Dragging the mic and right-click work the same way.
- A double-click now counts as one click (before, it opened the box and closed it again at once).
- New in the tray menu: **Open log (to report a problem)**.

## 0.8.0
**Both**
- New mode: **Polish (keeps my voice)**. Joins broken or half-finished English, fixes grammar and adds missing small words, while keeping your meaning and your own words.
- **Write like me**: paste a paragraph or two you wrote yourself, and Polish and Rephrase follow your style.
- **Show the changes before inserting** (in Settings, off by default): see what was changed and choose Insert or Use my words.
- **Copy button** in the box: copy what you've said so far and paste it anywhere.
- No more long dashes (—) in the text.
- SayIt no longer adds business words like *leverage*, *foster* or *synergy* unless you said them. If the AI adds one, SayIt asks again.
- In Fix grammar mode, if the AI changes too many of your words, SayIt keeps what you said.

**Chrome extension**
- Fixed: copying could fail silently on some websites; SayIt now tries three ways.


## 0.7.0
**Desktop app**
- **The box opens where you're typing.** On Windows SayIt finds the text cursor (Word, Notepad, Outlook and most apps); otherwise it uses where you last clicked. Choose "where I last moved it" or "next to the mic button" instead if you prefer.
- **Move and resize the box.** Drag its top bar to move it and its bottom-right corner to resize it. SayIt remembers the size. Moving the box never moves the mic button.
- New default shape: a bit taller than wide, easier to read. A− / A+ now changes the text size.
- **Light and dark theme** (or follow your computer), for the box and the mic button. The mic button turns red while you're recording.
- Fixed: clicking the mic button sometimes did nothing until you pressed the shortcut (a tiny hand movement was taken as a drag).
- Fixed: clicking the tray icon on Windows started recording in the wrong place; it now opens the menu.
- Speech now works with a Groq, OpenAI **or Gemini** key.

**Chrome extension**
- **Light and dark theme** for the listening box.
- Speech works with a Groq, OpenAI or Gemini key.
- Fixed: tapping SayIt could do nothing if Chrome's toolbar had taken keyboard focus for a moment.


## 0.6.0
**Chrome extension**
- **Much faster: same speech engine as the desktop app.** New default speech mode, *Fast and accurate (Groq)*: your voice is cut at each pause and turned into text while you keep talking, so the text is ready almost as soon as you press Done. It's also better with accents and names.
- The microphone permission is now asked **once for SayIt**, not on every website.
- Fixed: in Chrome's built-in speech mode, words could appear, vanish and come back, and some were lost when Chrome restarted listening. Half-heard words are now kept.
- Fixed: an API key could be lost if you switched provider straight after pasting it. Keys now save the moment you paste them.

**Desktop app**
- Fixed: saving a key for another provider (e.g. Claude) erased the Groq key, so the mic only opened settings. Each provider's key is now kept.
- Clear message when there's no speech key: Claude and Gemini can fix grammar, but SayIt needs a Groq (or OpenAI) key to turn speech into text.
- Opening SayIt again (Start menu, desktop shortcut or Applications) while it's running now brings back the floating button.
- SayIt now starts with your computer by default (untick it in the tray menu to stop).

## 0.5.0
**Both**
- Smoother grammar fixing: clearer instructions to the AI for full stops, commas, capitals and common grammar mistakes, while still never rephrasing.
- New: **Remove "um", "uh" and stutters** ("um so I I I think" → "so I think"). Real repeated words like "had had" are kept.
- Better **Rephrase**: removes rambling, repetition and self-corrections, keeps every fact, and avoids flowery words. Choose a style: Natural, Formal, Friendly, or Short and clear.
- **Update notices**: SayIt checks GitHub once a day and tells you when a new version is out.

**Desktop app (first public release)**
- Floating mic button that sits above every app and doesn't steal your cursor.
- `Alt+Shift+D` shortcut (changeable), Esc to cancel, tray / menu-bar icon, start with computer.
- Speech via Whisper (Groq or OpenAI key), transcribed at each pause while you talk, so text is ready quickly when you press Done.
- New size settings: **mic button** (Small / Medium / Large) and **text box** (Medium / Large / Extra large), plus A− / A+ on the box.
- Windows installer and portable zip; Mac apps for Apple Silicon and Intel.

**Chrome extension**
- Fixed: the `icons` folder was missing from the GitHub upload, so the extension wouldn't load.

## 0.4.0 (Chrome extension)
- Fixed: dictation stopping by itself on a weak connection. SayIt now reconnects and keeps listening, with no time limit.
- After inserting, a small 3-second pill with **Original** and **↶ Undo** replaces the big message; it disappears as soon as you type.
- Google Docs support.

## 0.3.0 (Chrome extension)
- Fixed: **Done** not responding on sites like Gmail, and the bar getting stuck.
- **Most accurate (Whisper)** speech option; **names and words** list; **finish by itself** after silence.

## 0.2.0 (Chrome extension)
- Grammar fixed while you speak, so text appears almost instantly after Done.
- Bigger listening box with A− / A+; real full stops and grammar via AI; choice of AI provider (Groq, Gemini, OpenAI, Claude, OpenRouter, custom).

## 0.1.0 (Chrome extension)
- First version: speak into any text box, grammar-only fixing, undo / use exact words.
