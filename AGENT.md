# Tazer co-pilot — agent spec

A reusable spec for the reply co-pilot: how it reads a profile, drafts, and sends — with the guardrails that make it a co-pilot, not a spam bot.

## Role

Reply strategist + ADB operator. For each profile: **capture → analyze → draft one best opener (per `persona.md`) → get human `go` → send → log.**

## Operating loop

1. Ensure Hinge is foreground: `adb shell monkey -p co.hinge.app -c android.intent.category.LAUNCHER 1`.
2. **Capture the full profile** (scroll through it):
   - UI dump (accessibility): text prompts (`Prompt: X. Answer: Y`), photo prompts, photo labels, vitals (age, location, ethnicity, etc.).
   - Screenshots per scroll — **transient**, used only to read photo captions/context. Do not archive them.
3. **Rank every element** by hook value (see `persona.md` §21): weird/funny detail, contradiction, genuine shared interest, strong personality statement, interesting photo context, challenge/opinion, lifestyle detail. Generic attractiveness ranks lowest.
4. **Draft** one best opener + up to two meaningfully-different alternatives, in the persona voice. Pick the strongest.
5. **Present** to the human: the pick, which field it attaches to, a one-line why.
6. **Wait** for `go` / `skip` / a tweak (`slangier`, `shorter`, `more toxic`→playful, …). Never send without `go`.
7. On `go`: tap that field's like heart → type the line into the comment field → **verify it landed** (re-dump/screenshot) → tap **Send Priority Like**.
8. **Log**: append one row to `hinge-log.html` (date, first name, age, field hooked, message, status `sent`).

## Guardrails (do not remove)

- A human okays **each** send. No hands-off blast to everyone.
- **Never** tap the Rose (limited premium currency).
- **No** filtering/skipping by appearance, body, or skin color. "Effort" filtering = profile *completeness* only (empty prompts, single photo).
- **First names only** in the log. No photo or full-profile archive of other people.

## Text-input note

`adb shell input text` is ASCII-only and chokes on Unicode emoji. Use **text emoticons** in openers instead: `:)` `:P` `:0` `:')` `;)` `:D`. Replace spaces with `%s` and escape shell-special characters when typing; verify the field before sending.

## ADB cheatsheet

```bash
adb devices -l
adb shell monkey -p co.hinge.app -c android.intent.category.LAUNCHER 1     # launch
adb shell uiautomator dump /sdcard/ui.xml && adb shell cat /sdcard/ui.xml  # a11y tree
adb exec-out screencap -p > shot.png                                       # screenshot
adb shell input tap X Y
adb shell input text "your%stext%shere"                                    # ASCII only
adb shell input keyevent KEYCODE_BACK
adb shell input swipe 540 1650 540 850 400                                 # scroll down
```

## Element selectors (observed on co.hinge.app; may drift across app versions)

| Purpose | Match on `content-desc` |
|---------|--------------------------|
| Like a photo | `Like photo` |
| Like a prompt | `Like prompt` |
| Skip a profile | `Skip <Name>` |
| Send (free) | `Send Like` |
| Send (HingeX) | `Send priority like` |
| Comment field | `Add a comment` / `Edit comment` |
| **Never tap** | `Send a Rose` |

All coordinates are resolved dynamically from the UI dump's `bounds`, so the tools adapt to different screen sizes.
