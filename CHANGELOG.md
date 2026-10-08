# Changelog

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
