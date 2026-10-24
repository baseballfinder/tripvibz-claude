#!/usr/bin/env python3
"""
Social share cards (the image Facebook, iMessage, X and Slack show for a link).

Every card is 1200x630 JPEG in assets/og/. build.mjs points each page's
og:image at its card; functions/t/[id].js does the same for shared takes.

  <slug>.jpg                       city feed + vote page: lead question over the photo
  <slug>-what-not-to-do.jpg        topic pages, one per city and topic
  <slug>-worst-times-to-visit.jpg
  <slug>-what-locals-do.jpg
  <slug>-add.jpg                   "What do tourists get wrong here?" (the post page)
  <slug>-take.jpg                  a shared take: "A <City> local says…" True / Nope
  home.jpg                         homepage
  cities.jpg                       the Cities page

Run after adding a city, a question or a photo, then commit assets/og/:
    python3 scripts/og_cards.py              # everything
    python3 scripts/og_cards.py knoxville    # one city's cards (+ home and cities)
"""
import io, json, os, sys, textwrap, urllib.request
from PIL import Image, ImageDraw, ImageFont

SB = "https://nkxorlktzbgwqnfwmuus.supabase.co"
KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB"  # public read key
HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "fonts", "Archivo.ttf")
MARK = os.path.join(HERE, "..", "assets", "brand", "mark-512.png")
OUT = os.path.join(HERE, "..", "assets", "og")
W, H, PAD = 1200, 630, 64
CORAL, INK, WHITE, SOFT = (255, 86, 48), (22, 20, 15), (255, 255, 255), (232, 226, 214)
JPEG = dict(quality=80, optimize=True, progressive=True)

THEMES = {
    "what-not-to-do": ("What not to do in {c}", "The mistakes visitors make, voted on by people who live there."),
    "worst-times-to-visit": ("Worst times to visit {c}", "The weeks to skip, and when to come instead. From locals."),
    "what-locals-do": ("What locals actually do in {c}", "Where people who live here actually go. Never on the top-10 lists."),
}
# Homepage mosaic: cities whose photos read instantly at thumbnail size.
HOME_CITIES = ["key-west", "new-orleans", "nashville", "chicago"]


def get(path):
    req = urllib.request.Request(SB + path, headers={"apikey": KEY, "User-Agent": "tripvibz-og"})
    return urllib.request.urlopen(req, timeout=30).read()


def font(size, weight):
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_axes([weight, 100])  # wght, wdth
    except Exception:
        pass
    return f


def cover(im, w=W, h=H):
    im = im.convert("RGB")
    s = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def shade(base, left=200, right=65):
    """Darken toward the left so white type always reads."""
    m = Image.new("L", base.size)
    d = ImageDraw.Draw(m)
    for x in range(base.width):
        d.line([(x, 0), (x, base.height)], fill=int(left - (left - right) * (x / base.width)))
    return Image.composite(Image.new("RGB", base.size, INK), base, m)


def fit(draw, text, max_w, max_lines, sizes, weight=900):
    for size in sizes:
        f = font(size, weight)
        avg = draw.textlength("abcdefghijklmnopqrstuvwxyz", font=f) / 26
        lines = textwrap.wrap(text, width=max(8, int(max_w / avg)))
        while lines and max(draw.textlength(l, font=f) for l in lines) > max_w:
            avg *= 1.05
            lines = textwrap.wrap(text, width=max(8, int(max_w / avg)))
        if len(lines) <= max_lines:
            return f, lines, size
    return f, lines[:max_lines], size


def kicker(d, text, x=PAD, y=PAD, fill=CORAL):
    kf = font(26, 800)
    kw = d.textlength(text, font=kf)
    d.rounded_rectangle([x, y, x + kw + 40, y + 50], radius=25, fill=fill)
    d.text((x + 20, y + 25), text, font=kf, fill=WHITE, anchor="lm")


def brand(base, d, right=W - PAD, y=PAD):
    bf = font(26, 800)
    bw = d.textlength("TripVibz", font=bf)
    d.text((right, y + 25), "TripVibz", font=bf, fill=WHITE, anchor="rm")
    mark = Image.open(MARK).convert("RGBA").resize((52, 52), Image.LANCZOS)
    base.paste(mark, (int(right - bw - 64), y - 1), mark)


def headline(d, text, y, max_w=W - PAD * 2 - 40, lines=4, sizes=(76, 70, 64, 58, 52, 48), color=WHITE, x=PAD):
    f, ls, size = fit(d, text, max_w, lines, sizes)
    lh = int(size * 1.12)
    for l in ls:
        d.text((x, y), l, font=f, fill=color)
        y += lh
    return y


def chips(d, labels, y=H - PAD - 56, x=PAD, solid=None, size=28):
    of = font(size, 700)
    for t in labels:
        tw = d.textlength(t, font=of)
        if x + tw + 44 > W - PAD:
            break
        if solid and t in solid:
            d.rounded_rectangle([x, y, x + tw + 44, y + 56], radius=28, fill=solid[t])
            d.text((x + 22, y + 28), t, font=of, fill=INK if solid[t] == WHITE else WHITE, anchor="lm")
        else:
            d.rounded_rectangle([x, y, x + tw + 44, y + 56], radius=28, outline=WHITE, width=3)
            d.text((x + 22, y + 28), t, font=of, fill=WHITE, anchor="lm")
        x += tw + 44 + 14


def subline(d, text, y, size=30, max_w=W - PAD * 2 - 120, color=SOFT):
    f, ls, s = fit(d, text, max_w, 2, (size, size - 2, size - 4), weight=600)
    for l in ls:
        d.text((PAD, y), l, font=f, fill=color)
        y += int(s * 1.3)
    return y


def photo_base(pb):
    return shade(cover(Image.open(io.BytesIO(pb))))


# ---------------------------------------------------------------- card types

def card_question(city, q, pb):
    base = photo_base(pb); d = ImageDraw.Draw(base)
    kicker(d, f"{city['name'].upper()} LOCALS, SETTLE THIS"); brand(base, d)
    headline(d, q["prompt"], PAD + 90)
    chips(d, [o["label"] for o in q["options"][:3]])
    return base


def card_theme(city, slug, pb):
    title, sub = THEMES[slug]
    base = photo_base(pb); d = ImageDraw.Draw(base)
    kicker(d, f"{city['name'].upper()} · ACCORDING TO LOCALS"); brand(base, d)
    y = headline(d, title.format(c=city["name"]), PAD + 90, lines=3, sizes=(84, 76, 70, 64, 58))
    subline(d, sub, y + 14)
    chips(d, ["True", "Nope", "Add yours"], solid={"True": WHITE, "Nope": CORAL})
    return base


def card_add(city, pb):
    base = photo_base(pb); d = ImageDraw.Draw(base)
    kicker(d, f"LIVE IN {city['name'].upper()}?"); brand(base, d)
    y = headline(d, "What do tourists get wrong here?", PAD + 90, lines=3, sizes=(88, 80, 72, 64))
    subline(d, "Say it in one sentence. Locals vote it True or Nope.", y + 14)
    chips(d, ["Never ___ because ___", "Skip ___. Do ___ instead."])
    return base


def card_take(city, pb):
    base = photo_base(pb); d = ImageDraw.Draw(base)
    kicker(d, f"A {city['name'].upper()} LOCAL SAYS"); brand(base, d)
    d.text((PAD - 4, PAD + 50), "“", font=font(190, 900), fill=CORAL)
    y = headline(d, "Is this true, or nope?", PAD + 190, lines=2, sizes=(84, 76, 70))
    subline(d, "Locals are voting. Tap to see the take and add yours.", y + 10)
    chips(d, ["True", "Nope"], solid={"True": WHITE, "Nope": CORAL}, size=32)
    return base


def card_home(cities, photos, leads):
    base = Image.new("RGB", (W, H), INK)
    # Right half: 2x2 photo mosaic with city labels.
    tw, th, x0 = 300, 315, W - 600
    lf = font(24, 800)
    for i, slug in enumerate(HOME_CITIES):
        if slug not in photos:
            continue
        tile = cover(Image.open(io.BytesIO(photos[slug])), tw, th)
        tile = Image.composite(Image.new("RGB", tile.size, INK), tile, Image.new("L", tile.size, 70))
        x, y = x0 + (i % 2) * tw, (i // 2) * th
        base.paste(tile, (x, y))
        name = next(c["name"] for c in cities if c["slug"] == slug)
        ImageDraw.Draw(base).text((x + 18, y + th - 22), name, font=lf, fill=WHITE, anchor="ls")
    d = ImageDraw.Draw(base)
    # Fade the mosaic's left edge into the text panel.
    for i in range(80):
        d.line([(x0 + i, 0), (x0 + i, H)], fill=tuple(int(c) for c in INK), width=1) if i == 0 else None
    mark = Image.open(MARK).convert("RGBA").resize((60, 60), Image.LANCZOS)
    base.paste(mark, (PAD, PAD - 6), mark)
    d.text((PAD + 74, PAD + 24), "TripVibz", font=font(34, 900), fill=WHITE, anchor="lm")
    y = headline(d, "The local take on every city.", PAD + 96, max_w=600 - PAD - 30, lines=4, sizes=(64, 58, 54, 50))
    # Two real lead questions as poll chips.
    qf = font(24, 700)
    y = max(y + 18, 420)
    for q in leads[:2]:
        t = q if len(q) <= 34 else q[:33].rstrip() + "…"
        w = d.textlength(t, font=qf)
        d.rounded_rectangle([PAD, y, PAD + w + 36, y + 48], radius=24, outline=WHITE, width=2)
        d.text((PAD + 18, y + 24), t, font=qf, fill=WHITE, anchor="lm")
        y += 60
    d.text((PAD, H - 34), "Locals vote. Visitors stop guessing.", font=font(22, 700), fill=CORAL, anchor="ls")
    return base


def card_cities(cities, photos):
    base = Image.new("RGB", (W, H), INK)
    picks = [c["slug"] for c in cities if c["slug"] in photos][:8]
    tw, th = W // 4, H // 2
    for i, slug in enumerate(picks):
        tile = cover(Image.open(io.BytesIO(photos[slug])), tw, th)
        base.paste(tile, ((i % 4) * tw, (i // 4) * th))
    base = shade(base, left=225, right=140)
    d = ImageDraw.Draw(base)
    kicker(d, f"{len(cities)} CITIES AND COUNTING"); brand(base, d)
    y = headline(d, "Pick your city. Settle what tourists get wrong.", PAD + 90, lines=3, sizes=(76, 70, 64))
    subline(d, "Don't see yours? One tap to ask for it.", y + 14)
    return base


# ---------------------------------------------------------------- run

def main(only):
    cities = json.loads(get("/rest/v1/cities?select=id,name,state,slug,photo&order=sort"))
    qs = json.loads(get("/rest/v1/questions?select=city_id,prompt,options,sort&active=eq.true&order=sort"))
    os.makedirs(OUT, exist_ok=True)
    meta_path = os.path.join(OUT, "cards.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    photos = {}
    for c in cities:
        try:
            photos[c["slug"]] = get("/storage/v1/object/public/city-photos/" + urllib.request.quote(c.get("photo") or c["slug"] + ".webp"))
        except Exception:
            pass
    save = lambda im, name: im.save(os.path.join(OUT, name), "JPEG", **JPEG)
    for c in cities:
        if only and c["slug"] not in only:
            continue
        pb = photos.get(c["slug"])
        if not pb:
            print(f"  skip {c['slug']}: no photo"); continue
        mine = [q for q in qs if q["city_id"] == c["id"]]
        if mine:
            save(card_question(c, mine[0], pb), f"{c['slug']}.jpg")
            meta[c["slug"]] = {"prompt": mine[0]["prompt"]}
        for t in THEMES:
            save(card_theme(c, t, pb), f"{c['slug']}-{t}.jpg")
        save(card_add(c, pb), f"{c['slug']}-add.jpg")
        save(card_take(c, pb), f"{c['slug']}-take.jpg")
        print(f"  {c['slug']}: 6 cards")
    leads = [next((q["prompt"] for q in qs if q["city_id"] == c["id"]), None) for c in cities if c["slug"] in ("chicago", "seattle")]
    save(card_home(cities, photos, [l for l in leads if l]), "home.jpg")
    save(card_cities(cities, photos), "cities.jpg")
    json.dump(dict(sorted(meta.items())), open(meta_path, "w"), indent=2)
    print("  home.jpg, cities.jpg")


if __name__ == "__main__":
    main(set(sys.argv[1:]))
