#!/usr/bin/env python3
"""
Crop the profile photo out of Hinge screenshots and build a collage.

Screenshots are 1080x2400 (phone screen). The profile photo always sits in a
fixed card region below the name header and above the opener text box:

    left=108  top=242  right=972  bottom=1104      (864 x 862)

Usage:
    python3 crop_collage.py                                  # crop all, collage of 100
    python3 crop_collage.py --count all                      # one sheet, every image
    python3 crop_collage.py --count all --per-sheet 110      # 8 numbered sheets
    python3 crop_collage.py --pick random                    # random sample vs. first N
"""

import argparse
import random
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "screenshots"
OUT_CROPS = ROOT / "screenshots_cropped"

# Photo region inside a 1080x2400 screenshot
CROP_BOX = (108, 242, 972, 1104)
EXPECTED_SIZE = (1080, 2400)


def crop_all(force=False):
    OUT_CROPS.mkdir(exist_ok=True)
    files = sorted(SRC.glob("*.png"))
    done, odd_size, bad = [], [], []

    for f in files:
        dest = OUT_CROPS / f.name
        if dest.exists() and not force:
            done.append(dest)
            continue
        try:
            with Image.open(f) as im:
                if im.size != EXPECTED_SIZE:
                    # Scale the box proportionally for any odd-sized screenshot.
                    sx, sy = im.width / EXPECTED_SIZE[0], im.height / EXPECTED_SIZE[1]
                    box = (
                        int(CROP_BOX[0] * sx), int(CROP_BOX[1] * sy),
                        int(CROP_BOX[2] * sx), int(CROP_BOX[3] * sy),
                    )
                    odd_size.append((f.name, im.size))
                else:
                    box = CROP_BOX
                im.convert("RGB").crop(box).save(dest)
        except OSError as e:
            # truncated / corrupt capture — skip it rather than kill the run
            bad.append((f.name, str(e)))
            dest.unlink(missing_ok=True)
            continue
        done.append(dest)

    if odd_size:
        print(f"note: {len(odd_size)} screenshot(s) had a non-standard size, box scaled:")
        for name, size in odd_size[:5]:
            print(f"  {name} {size}")
    if bad:
        print(f"note: skipped {len(bad)} unreadable file(s):")
        for name, err in bad[:5]:
            print(f"  {name}: {err}")
    print(f"cropped {len(done)} images -> {OUT_CROPS}")
    return done


def select(crops, count, pick):
    """Pick which crops go into the collage. count=None means all of them."""
    if count is None or count >= len(crops):
        return list(crops)
    if pick == "random":
        random.seed(0)
        return sorted(random.sample(crops, count))
    if pick == "last":
        return crops[-count:]
    return crops[:count]


def build_collage(chosen, cols, cell, gap, bg, out_path):
    n = len(chosen)
    rows = -(-n // cols)  # ceil
    w = cols * cell + (cols + 1) * gap
    h = rows * cell + (rows + 1) * gap
    sheet = Image.new("RGB", (w, h), bg)

    for i, path in enumerate(chosen):
        r, c = divmod(i, cols)
        with Image.open(path) as im:
            # center-crop to square, then resize to the cell
            s = min(im.size)
            l = (im.width - s) // 2
            t = (im.height - s) // 2
            tile = im.crop((l, t, l + s, t + s)).resize((cell, cell), Image.LANCZOS)
        sheet.paste(tile, (gap + c * (cell + gap), gap + r * (cell + gap)))

    sheet.save(out_path, quality=92)
    mb = out_path.stat().st_size / 1e6
    print(f"collage: {n} images, {cols}x{rows} grid, {w}x{h}px, {mb:.1f}MB -> {out_path.name}")


def parse_count(v):
    return None if str(v).lower() == "all" else int(v)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--count", type=parse_count, default=100,
                   help="images in the collage, or 'all'")
    p.add_argument("--cols", type=int, default=0,
                   help="grid columns (0 = auto, near-square)")
    p.add_argument("--cell", type=int, default=320, help="tile size in px")
    p.add_argument("--gap", type=int, default=8)
    p.add_argument("--bg", default="#111111")
    p.add_argument("--pick", choices=["first", "last", "random"], default="first")
    p.add_argument("--per-sheet", type=int, default=0,
                   help="split across multiple numbered sheets of N images each")
    p.add_argument("--out", default=None)
    p.add_argument("--force", action="store_true", help="re-crop even if output exists")
    p.add_argument("--crop-only", action="store_true")
    a = p.parse_args()

    crops = crop_all(force=a.force)
    if a.crop_only:
        return

    chosen = select(crops, a.count, a.pick)
    label = "all" if a.count is None else str(a.count)

    if a.per_sheet:
        pages = [chosen[i:i + a.per_sheet] for i in range(0, len(chosen), a.per_sheet)]
        width = len(str(len(pages)))
        for i, page in enumerate(pages, 1):
            cols = a.cols or int(len(page) ** 0.5 + 0.999)
            out = ROOT / f"collage_sheet{i:0{width}d}.jpg"
            build_collage(page, cols, a.cell, a.gap, a.bg, out)
        print(f"{len(pages)} sheets covering {len(chosen)} images")
    else:
        cols = a.cols or int(len(chosen) ** 0.5 + 0.999)
        out = Path(a.out) if a.out else ROOT / f"collage_{label}.jpg"
        build_collage(chosen, cols, a.cell, a.gap, a.bg, out)


if __name__ == "__main__":
    main()
