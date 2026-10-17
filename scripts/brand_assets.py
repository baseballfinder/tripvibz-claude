#!/usr/bin/env python3
"""
TripVibz logo files (option G: jet over a beach sunset).

Writes the vector files to assets/brand/. PNG/ICO sizes are rendered from
these by scripts/brand_png.mjs (headless Chromium, so the SVGs are the
single source of truth).

    python3 scripts/brand_assets.py && node scripts/brand_png.mjs
"""
import os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "assets", "brand")
CORAL, INK, PAPER, SUN, SAND, SEA_DARK = "#ff5630", "#16140f", "#fbfaf7", "#ffd27a", "#f4dcb0", "#0e3b4d"

JET = ("M12 1c1 0 1.6 1.2 1.6 2.6V9l8.4 5v2.2l-8.4-2.6V19l2.6 2v1.6L12 21.6 8.8 22.6V21"
       "l2.6-2v-5.4L3 16.2V14l8.4-5V3.6C11.4 2.2 11 1 12 1z")


def scene(clip, cid, sea=INK, simple=False):
    """The 48x48 beach scene inside a clip shape."""
    parts = [f'<defs><clipPath id="{cid}">{clip}</clipPath></defs><g clip-path="url(#{cid})">',
             f'<rect width="48" height="48" fill="{CORAL}"/>']
    if simple:  # favicon: sun, sea, plane only
        parts += [f'<circle cx="24" cy="31" r="10" fill="{SUN}"/>',
                  f'<rect y="31" width="48" height="17" fill="{sea}"/>',
                  f'<path transform="translate(30 13) rotate(68) scale(0.85) translate(-12 -12)" d="{JET}" fill="{PAPER}"/>']
    else:
        parts += [f'<circle cx="26" cy="31" r="9" fill="{SUN}"/>',
                  f'<rect y="31" width="48" height="17" fill="{sea}"/>',
                  f'<path d="M2 36c3-1.6 6-1.6 9 0s6 1.6 9 0 6-1.6 9 0 6 1.6 9 0 6-1.6 9 0" fill="none" stroke="{SUN}" stroke-width="1.6" stroke-linecap="round"/>',
                  f'<path d="M0 45c10-5 30-5 48 1v2H0z" fill="{SAND}"/>',
                  f'<path d="M12 45c1-6 0-12-3-17" fill="none" stroke="{INK}" stroke-width="2.4" stroke-linecap="round"/>',
                  f'<path d="M9 28c-3-4-7-4-9-2 3-1 6 0 9 2z" fill="{INK}"/>',
                  f'<path d="M9 28c0-5-3-7-6-7 2 2 4 4 6 7z" fill="{INK}"/>',
                  f'<path d="M9 28c3-5 7-5 9-3-3 0-6 1-9 3z" fill="{INK}"/>',
                  f'<path d="M9 28c4-2 7 0 7 3-2-2-5-3-7-3z" fill="{INK}"/>',
                  f'<path transform="translate(32 13) rotate(68) scale(0.62) translate(-12 -12)" d="{JET}" fill="{PAPER}"/>']
    parts.append("</g>")
    return "".join(parts)


CIRCLE = '<circle cx="24" cy="24" r="23"/>'
ROUNDED = '<rect width="48" height="48" rx="11"/>'
SQUARE = '<rect width="48" height="48"/>'


def svg(w, h, body, vb=None, label="TripVibz"):
    vb = vb or f"0 0 {w} {h}"
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb}" '
            f'role="img" aria-label="{label}"><title>{label}</title>{body}</svg>\n')


def wordmark_path(text, size, tracking_em=-0.031):
    """'TripVibz' in Archivo Black-weight as outlines, so the SVG needs no font."""
    font = TTFont(os.path.join(HERE, "fonts", "Archivo.ttf"))
    font = instantiateVariableFont(font, {"wght": 900, "wdth": 100})
    gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
    upm = font["head"].unitsPerEm
    s = size / upm
    pen = SVGPathPen(gs)
    x = 0
    for ch in text:
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (s, 0, 0, -s, x, 0)))
        x += hmtx[g][0] * s + tracking_em * size
    asc = font["hhea"].ascent * s
    cap = font["OS/2"].sCapHeight * s
    return pen.getCommands(), x - tracking_em * size, cap


def lockup(text_color, sea):
    # Badge 96px, gap 22px, wordmark cap height matched to ~46% of badge.
    path, tw, cap = wordmark_path("TripVibz", 60)
    badge, gap, pad = 96, 22, 4
    w = round(pad + badge + gap + tw + pad)
    h = badge + pad * 2
    ty = pad + badge / 2 + cap / 2
    body = (f'<g transform="translate({pad} {pad}) scale({badge / 48})">{scene(CIRCLE, "c", sea)}</g>'
            f'<path transform="translate({pad + badge + gap} {ty:.2f})" d="{path}" fill="{text_color}"/>')
    return svg(w, h, body)


def main():
    os.makedirs(OUT, exist_ok=True)
    files = {
        "mark.svg": svg(48, 48, scene(CIRCLE, "c")),                      # round badge, transparent corners
        "mark-square.svg": svg(48, 48, scene(SQUARE, "c")),               # full bleed, for app icons / profile pics
        "mark-rounded.svg": svg(48, 48, scene(ROUNDED, "c")),             # rounded square
        "favicon.svg": svg(48, 48, scene(ROUNDED, "c", simple=True)),     # browser tab
        "logo.svg": lockup(INK, INK),                                      # on light backgrounds
        "logo-white.svg": lockup(PAPER, SEA_DARK),                         # on dark backgrounds
    }
    for name, data in files.items():
        with open(os.path.join(OUT, name), "w") as f:
            f.write(data)
        print("  ", name)


if __name__ == "__main__":
    main()
