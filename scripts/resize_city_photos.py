#!/usr/bin/env python3
"""
Resize + convert city photos to web-ready WebP.

Drop the original images into  city-photos-src/  then run:
    python3 scripts/resize_city_photos.py

It matches each source file to a city slug by keyword, resizes the longest
edge to 1600px, encodes WebP q72, and writes  city-photos-out/<slug>.webp
Upload those to the Supabase city-photos bucket (overwriting), and the site
resolves them via the default {slug}.webp path.
"""
import os, sys
from PIL import Image

SRC = "city-photos-src"
OUT = "city-photos-out"
MAX_EDGE = 1600
QUALITY = 72

# keyword (lowercased, matched against filename) -> slug
MATCH = [
    ("orlando", "orlando"),
    ("tampa", "tampa"),
    ("castillo", "st-augustine"), ("augustine", "st-augustine"),
    ("fort-myers", "fort-myers"), ("myers", "fort-myers"),
    ("sarasota", "sarasota"),
    ("naples", "naples"),
    ("daytona", "daytona-beach"),
]

def slug_for(fname):
    low = fname.lower()
    for kw, slug in MATCH:
        if kw in low:
            return slug
    return None

def main():
    os.makedirs(OUT, exist_ok=True)
    files = [f for f in os.listdir(SRC)
             if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))]
    if not files:
        print(f"No images in {SRC}/ — drop the 7 originals there first.")
        sys.exit(1)

    seen = {}
    for f in sorted(files):
        slug = slug_for(f)
        if not slug:
            print(f"  ?  {f}  — no slug match, skipped")
            continue
        if slug in seen:
            print(f"  !  {f}  — {slug} already done from {seen[slug]}, skipped")
            continue
        seen[slug] = f

        im = Image.open(os.path.join(SRC, f)).convert("RGB")
        w, h = im.size
        scale = min(1.0, MAX_EDGE / max(w, h))
        if scale < 1.0:
            im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
        out_path = os.path.join(OUT, f"{slug}.webp")
        im.save(out_path, "WEBP", quality=QUALITY, method=6)
        kb = os.path.getsize(out_path) / 1024
        print(f"  ✓  {f}  ->  {slug}.webp  ({im.size[0]}x{im.size[1]}, {kb:.0f}KB)")

    missing = {s for _, s in MATCH} - set(seen.values() and seen.keys())
    if missing:
        print("\n  Missing slugs (no source matched):", ", ".join(sorted(missing)))

if __name__ == "__main__":
    main()
