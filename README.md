# Tazer — Hinge reply co-pilot & outreach toolkit

A personal-use toolkit for driving **Hinge on Android over USB** with ADB. Three parts:

1. **`hinge-liker.js`** — sends Priority Likes with human-like pacing and a randomized skip cadence.
2. **Reply co-pilot** (`persona.md` + `AGENT.md`) — reads a profile, ranks every element, and drafts one tailored opener in your voice. **You approve each send.**
3. **`hinge-log.html`** — a local, editable log of who you reached out to, what you sent, and how it went.

## Design principles (the non-goals are load-bearing)

- **Human-approved sends.** The co-pilot drafts and picks the line; a human okays each send (`go` / `skip`). No autonomous mass-messaging — that's both a ban magnet and the exact "sendable to 100 people unchanged" failure the persona is built to avoid.
- **No appearance/identity filtering.** It never sorts or rejects people by skin color, body, or any physical/demographic trait. If you filter for "low-effort" profiles, that's based on profile *completeness* (empty prompts, a single photo) — not looks.
- **No data hoarding.** Screenshots and UI dumps are transient working files (git-ignored). The log stores **first names + your own messages/outcomes only**, locally, never uploaded. No archive of other people's photos or profiles.
- **Honest about the rules.** Automating Hinge violates its Terms of Service and risks account bans/shadowbans (higher risk for auto-*messaging* than auto-*liking*). Use accordingly and keep volume sane.

## Quick start

```bash
# 1. Install adb + Node (see docs/setup.md)
# 2. Enable USB debugging on the phone, plug in, authorize
adb devices -l                 # confirm your phone shows as "device"

# 3. Dry-run the like tool (finds buttons, sends NOTHING)
npm run dry

# 4. Live like run (5 likes, human pacing, skips ~1 in 3–4)
npm run like -- 5
```

## Files

| File | What it is |
|------|------------|
| `hinge-liker.js` | ADB auto-like tool. Env: `NUM_LIKES`, `MIN_GAP`, `MAX_GAP`, `RUN_MIN`, `RUN_MAX`, `DRY_RUN=1` |
| `persona.md` | The reply style guide — how openers are written and ranked |
| `AGENT.md` | The co-pilot's operating loop + ADB cheatsheet + element selectors |
| `hinge-log.html` | Local outreach CRM (open in a browser; edits save in-browser) |
| `docs/setup.md` | adb install, USB debugging, device profiling |

## Requirements

- macOS / Linux / WSL, **Node ≥ 18**
- **Android Platform Tools** (`adb`)
- An Android phone with **USB debugging** enabled

## Responsible use

This automates *your own account* and interacts with *real people*. Keep sends human-approved, keep volume modest, don't try to deceive people at scale, and remember the person on the other end is real. Automating the app is against Hinge's ToS — you accept that risk. Don't publish this repo with any captured profile data in it (the `.gitignore` is set up to keep that out).
