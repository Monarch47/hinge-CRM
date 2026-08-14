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

## Notes

- Some dating apps set `FLAG_SECURE`, which makes `screencap` return a black image. Hinge's discover screen currently allows screenshots; if that ever changes, rely on `uiautomator dump` (the accessibility tree works regardless and is what the tools key off).
- The tools read element positions from the UI dump at runtime, so they adapt to different screen sizes without hardcoded coordinates.
