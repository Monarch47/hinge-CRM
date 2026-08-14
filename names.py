#!/usr/bin/env python3
"""
names.py — read the send-sheet screenshots and report who you've opened.

hinge-opener.js saves every send sheet as  YYYY-MM-DD_HH-MM-SS_Name.png
(the name comes from the "<Name>'s photo" accessibility label, with every
non-alphanumeric char turned into "_", and "profile" as the fallback when the
label wasn't readable). So the filename is the only name record we have.

Usage (from the repo root):
  python3 names.py                # summary: totals, duplicates, unknowns
  python3 names.py --all          # also list every entry, oldest first
  python3 names.py --json         # machine-readable dump
  python3 names.py --sync         # append missing rows into hinge-log.html
  python3 names.py --dir shots    # point at a different folder

Caveat: a shared first name is NOT proof of the same person — 28 files named
"S" are 28 different profiles whose label only exposed an initial. Treat the
duplicate list as "worth eyeballing", not as truth.
"""
import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# 2026-08-13_08-02-16_Tahira.png  ->  date, time, raw name
FILENAME = re.compile(r"^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_(.*)\.png$")

# Two ways a name comes out mangled:
#   emoji  -> their decimal codepoint, e.g. "P_128060_"  ("P🐼")
#   "<3"   -> HTML entity leftovers,   e.g. "Karissa_lt_3"
# A surname is just an underscore ("Tanya_verma"), which the "_"->" " pass fixes.
EMOJI_RESIDUE = re.compile(r"_\d{4,7}_?")
ENTITY_RESIDUE = re.compile(r"\b(lt|gt|amp|quot|apos|nbsp)\b\s*\d*", re.I)

# Names the app never gave us — not real people, just missing labels.
PLACEHOLDERS = {"profile", ""}

# hinge-log.html keeps its data between these two comments.
ROWS_START = "/*ROWS_START*/"
ROWS_END = "/*ROWS_END*/"


def clean(raw: str) -> str:
    """Turn a filename fragment back into something name-shaped."""
    name = EMOJI_RESIDUE.sub(" ", raw)
    name = name.replace("_", " ")
    name = ENTITY_RESIDUE.sub(" ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def scan(folder: Path):
    """Yield one dict per screenshot, oldest first."""
    entries = []
    for png in sorted(folder.glob("*.png")):
        m = FILENAME.match(png.name)
        if not m:
            continue
        date, hh, mm, ss = m.group(1), m.group(2), m.group(3), m.group(4)
        name = clean(m.group(5))
        # The opener stamps filenames with toISOString() — i.e. UTC. Show them in
        # your own timezone instead, which can shift a late-night send to the next day.
        utc = datetime.strptime(f"{date} {hh}:{mm}:{ss}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        local = utc.astimezone()
        entries.append({
            "file": png.name,
            "id": png.stem,              # unique + stable: it's the filename
            "date": local.strftime("%Y-%m-%d"),
            "time": local.strftime("%H:%M"),
            "utc_date": date,
            "name": name,
            "key": name.lower(),
            "known": name.lower() not in PLACEHOLDERS,
            # a single letter is a partial label, not a real first name
            "partial": len(name) <= 2,
        })
    return entries


def sync_html(entries, log: Path, shots_rel: str):
    """Append a row per screenshot into hinge-log.html, between the ROWS markers.

    Idempotent: rows whose id is already in the file are skipped, so hand-written
    rows and your localStorage status/notes edits (keyed by id) survive re-runs.
    """
    html = log.read_text(encoding="utf-8")
    end = html.find(ROWS_END)
    if html.find(ROWS_START) < 0 or end < 0:
        sys.exit(f"markers {ROWS_START} / {ROWS_END} not found in {log}")

    have = set(re.findall(r'id:\s*"([^"]+)"', html))
    new = [e for e in entries if e["id"] not in have]
    if not new:
        return 0

    lines = []
    for e in new:
        row = {
            "id": e["id"],
            "date": e["date"],
            "time": e["time"],
            "name": e["name"] if e["known"] else "",
            "age": "",
            "field": "",
            "message": "",        # not recoverable from a filename — see README note
            "status": "sent",
            "notes": "",
            "shot": f"{shots_rel}/{e['file']}",
        }
        lines.append("{" + ", ".join(f"{k}:{json.dumps(v, ensure_ascii=False)}" for k, v in row.items()) + "},")

    html = html[:end] + "\n".join(lines) + "\n" + html[end:]
    log.write_text(html, encoding="utf-8")
    return len(new)


def main():
    ap = argparse.ArgumentParser(description="List names + duplicates from Hinge send-sheet screenshots.")
    # matches SHOTS_DIR in hinge-opener.js
    ap.add_argument("--dir", default="screenshots", help="screenshots folder (default: screenshots/)")
    ap.add_argument("--all", action="store_true", help="list every entry, not just duplicates")
    ap.add_argument("--json", action="store_true", help="dump JSON instead of a report")
    ap.add_argument("--sync", action="store_true", help="append missing rows into hinge-log.html")
    ap.add_argument("--log", default="hinge-log.html", help="the log page to sync (default: hinge-log.html)")
    args = ap.parse_args()

    folder = Path(args.dir).expanduser().resolve()
    if not folder.is_dir():
        sys.exit(f"not a folder: {folder}")

    entries = scan(folder)
    if not entries:
        sys.exit(f"no opener screenshots found in {folder}")

    if args.sync:
        log = Path(args.log).expanduser().resolve()
        if not log.is_file():
            sys.exit(f"no such file: {log}")
        # src path the browser will use: relative to the html page, not to cwd
        try:
            shots_rel = folder.relative_to(log.parent).as_posix()
        except ValueError:
            shots_rel = folder.as_posix()
        added = sync_html(entries, log, shots_rel)
        print(f"{log.name}: +{added} rows ({len(entries) - added} already there)")
        return

    by_name = defaultdict(list)
    for e in entries:
        if e["known"]:
            by_name[e["key"]].append(e)

    named = [e for e in entries if e["known"] and not e["partial"]]
    initials = [e for e in entries if e["known"] and e["partial"]]
    unknown = [e for e in entries if not e["known"]]
    dupes = {k: v for k, v in by_name.items() if len(v) > 1}

    if args.json:
        print(json.dumps({
            "folder": str(folder),
            "total": len(entries),
            "unique_names": len(by_name),
            "entries": entries,
            "duplicates": {k: [e["file"] for e in v] for k, v in sorted(dupes.items())},
        }, indent=2, ensure_ascii=False))
        return

    print(f"folder      : {folder}")
    print(f"screenshots : {len(entries)}   ({entries[0]['date']} → {entries[-1]['date']})")
    print(f"real names  : {len(named)}     unique: {len({e['key'] for e in named})}")
    print(f"initial only: {len(initials)}  (label gave 1-2 chars — unusable)")
    print(f"no name     : {len(unknown)}   (saved as 'profile')")

    real_dupes = {k: v for k, v in dupes.items() if len(k) > 2}
    print(f"\n— repeats worth checking ({len(real_dupes)}) —")
    for key, hits in sorted(real_dupes.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        print(f"  {hits[0]['name']:<20} x{len(hits)}")
        for e in hits:
            print(f"      {e['date']} {e['time']}  {e['file']}")

    initial_dupes = {k: v for k, v in dupes.items() if len(k) <= 2}
    if initial_dupes:
        collapsed = ", ".join(f"{k.upper()} x{len(v)}" for k, v in
                              sorted(initial_dupes.items(), key=lambda kv: -len(kv[1])))
        print(f"\n— repeated initials (almost certainly different people) —\n  {collapsed}")

    if args.all:
        print(f"\n— every entry ({len(entries)}) —")
        for e in entries:
            print(f"  {e['date']} {e['time']}  {e['name'] or '(none)'}")


if __name__ == "__main__":
    main()
