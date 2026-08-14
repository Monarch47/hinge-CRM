# Tazer — Hinge reply co-pilot

A personal-use co-pilot that drives **Hinge on Android over ADB**. The release script is **`hinge.js`**: one profile, one drafted like-comment, then the phone locks.

```
scrape text → crop the first photo → draft a like-comment → type it
onto the hooked card → append hinge-log.html → lock the phone
```

Never taps the Rose. Locks on any exit (success, error, Ctrl+C).

## Quick start

```bash
# 1. adb + Node ≥ 18 + Python 3 with Pillow  (see docs/setup.md)
# 2. USB debugging on, phone plugged in and authorized
adb devices -l

# 3. OpenAI key (used only to draft the line)
cp .env.example .env   # then paste OPENAI_API_KEY=

# 4. Open Hinge to Discover, then:
npm start              # or: node hinge.js

# Type the line, screenshot, do not send:
npm run dry            # or: DRY_RUN=1 node hinge.js
```

Wireless debugging: `SERIAL=192.168.1.42:5555 node hinge.js`

## What `hinge.js` does

1. Wakes the phone, launches Hinge, and makes sure Discover is showing a card.
2. Scrolls the profile and reads prompts, photo labels, and vitals from the accessibility tree.
3. Crops the first photo (local file only; git-ignored).
4. Asks the model for **one** hook-specific opener (`opener-prompt.md` / `persona.md`).
5. Taps that card's like heart, types the line, sends a **Priority Like** (unless `DRY_RUN=1`).
6. Appends a row to `hinge-log.html` and puts the screen to sleep.

## Design principles

- **No appearance/identity filtering.** It never sorts or rejects people by skin color, body, or any physical/demographic trait. “Low-effort” means empty prompts or a single photo — not looks.
- **No data hoarding.** Screenshots and UI dumps are transient (git-ignored). The log stores **first names + your own messages/outcomes** locally. Photo crops stay next to the log on disk, never uploaded.
- **Never the Rose.** Limited premium currency is off-limits.
- **Honest about the rules.** Automating Hinge violates its Terms of Service and risks bans/shadowbans. Use accordingly and keep volume sane.

## Files

| File | What it is |
|------|------------|
| **`hinge.js`** | **v1 entrypoint.** One profile: scrape → crop → draft → type → log → lock |
| `hinge-read.js` | Implementation `hinge.js` boots |
| `opener-prompt.md` | System prompt for the drafted like-comment |
| `persona.md` | Reply style guide — how openers are ranked and written |
| `AGENT.md` | Co-pilot spec, ADB cheatsheet, element selectors |
| `hinge-log.html` | Local outreach log (open in a browser; status/notes save in-browser) |
| `docs/setup.md` | adb, USB debugging, `.env`, Pillow |
| `hinge-liker.js` | Older like-only tool (no comment) |
| `hinge-opener.js` | Older random-line loop |

## Environment

| Var | Default | Meaning |
|-----|---------|---------|
| `OPENAI_API_KEY` | (required) | From `.env`. Never commit this file. |
| `DRY_RUN=1` | off | Type the line, do not tap Send |
| `NODRAFT=1` | off | Scrape only — no draft, no send |
| `SERIAL` | first `adb` device | e.g. `192.168.1.42:5555` |
| `MODEL` | `gpt-5.6` | Chat Completions model |
| `VERBOSE=1` | off | Print every harvested node |
| `LOAD_TIMEOUT` | `12000` | ms to wait for a screen |
| `ADB` | auto-detect | Path to `adb` |

## Requirements

- macOS / Linux / WSL, **Node ≥ 18**
- **Android Platform Tools** (`adb`)
- **Python 3** + **Pillow** (first-photo crop)
- An Android phone with **USB debugging** (or wireless `SERIAL`)
- An **OpenAI API key** in `.env`

## Responsible use
<img width="1030" height="639" alt="image" src="https://github.com/user-attachments/assets/1365b14d-33bf-4f6e-ab35-3ca033bb43af" />

This automates *your own account* and interacts with *real people*. Keep volume modest, don't try to deceive people at scale, and remember the person on the other end is real. Automating the app is against Hinge's ToS — you accept that risk. Don't publish this repo with any captured profile data in it (the `.gitignore` is set up to keep that out).
