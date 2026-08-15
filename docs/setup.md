# Setup

## 1. Prerequisites

- **Node ≥ 18**
- **Android Platform Tools** (`adb`):
  - macOS: `brew install --cask android-platform-tools`
  - Debian/Ubuntu: `sudo apt install android-tools-adb`
  - Windows: install "SDK Platform Tools" and add to PATH (WSL works too)

## 2. Enable USB debugging on the phone

1. Settings → **About phone** → tap **Build number** 7× (unlocks Developer options).
2. Settings → **System** → **Developer options** → enable **USB debugging**.
3. Plug the phone into the computer with a **data** cable.
4. On the phone, tap **Allow** on the "Allow USB debugging?" prompt (check "Always allow from this computer").

## 3. Verify the connection

```bash
adb devices -l
```

You should see your device listed as `device`. If it says `unauthorized`, re-accept the prompt on the phone. If nothing shows, try another cable/port.

## 4. OpenAI key + photo crop

```bash
cp .env.example .env    # then set OPENAI_API_KEY=
pip3 install pillow     # first-photo crop (python3)
```

`.env` is git-ignored. Do not commit a real key.

## 5. Profile the device (optional sanity checks)

```bash
adb shell wm size                       # e.g. Physical size: 1080x2400
adb shell wm density                    # e.g. Physical density: 480
adb shell getprop ro.build.version.release
adb shell pm list packages | grep hinge # -> package:co.hinge.app
```

## 6. ADBKeyboard (optional — Unicode & emoji openers)

`adb shell input text` maps characters through the device KeyCharacterMap, so it is
ASCII-only: emoji, accents and CJK are dropped (and some ROMs throw on unmappable
chars). [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) is a tiny IME that
accepts text over a broadcast instead, which lets the openers carry real Unicode.

```bash
curl -L -o ~/Downloads/ADBKeyboard.apk \
  https://github.com/senzhk/ADBKeyBoard/releases/download/v2.5-dev/keyboardservice-debug.apk
adb install -r ~/Downloads/ADBKeyboard.apk
adb shell ime enable com.android.adbkeyboard/.AdbIME
```

Enabling only adds it to the keyboard list — it does **not** take over from your
normal keyboard. Verify:

```bash
adb shell pm list packages | grep adbkeyboard   # -> package:com.android.adbkeyboard
adb shell settings get secure default_input_method
```

`hinge-opener.js` and `hinge-read.js` detect the package at runtime. When it is
present **and** the line contains non-ASCII, they save the current IME, switch to
ADBKeyboard, send the text base64-encoded over `ADB_INPUT_B64`, then switch the
previous IME back automatically. When it is absent they fall back to `input text`
and log which characters were dropped. Nothing else needs configuring — no shell
helper or `~/.zshrc` function is involved.

They never restore ADBKeyboard itself or the Google TTS *voice* IME, which Android
reports as "current" whenever no real keyboard is selected — restoring that is how
you end up stuck with the mic keyboard. If the saved IME is one of those, they fall
back to Gboard
(`com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME`),
then to the first other enabled keyboard. Set `KEYBOARD_IME=<id>` to force a
specific one.

Gotchas:

- Play Protect blocks the install on some ROMs (it is an unsigned debug build) —
  clear the on-device dialog with **Install anyway**. On Realme/Xiaomi you may also
  need *Developer options → Install via USB*.
- While ADBKeyboard is the active IME the phone shows **no on-screen keys**. That is
  expected. If a run is interrupted mid-send and leaves it active, restore with
  `adb shell ime set com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME`
  (or pick your keyboard from the notification switcher).

Driving it by hand, if you ever need to:

```bash
adb shell ime set com.android.adbkeyboard/.AdbIME                  # take over
adb shell am broadcast -a ADB_INPUT_B64 --es msg "$(printf '%s' 'hi 🙂' | base64)"
adb shell ime set com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME  # give it back
```

## Notes

- Some dating apps set `FLAG_SECURE`, which makes `screencap` return a black image. Hinge's discover screen currently allows screenshots; if that ever changes, rely on `uiautomator dump` (the accessibility tree works regardless and is what the tools key off).
- The tools read element positions from the UI dump at runtime, so they adapt to different screen sizes without hardcoded coordinates.
