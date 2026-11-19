#!/usr/bin/env python3
"""
Social share cards (the image Facebook, iMessage, X and Slack show for a link).

Every card is 1200x630 JPEG in assets/og/. build.mjs points each page's
og:image at its card; functions/t/[id].js does the same for shared takes.

  <slug>.jpg                       city feed + vote page: lead question over the photo
  <slug>-what-not-to-do.jpg        topic pages, one per city and topic
  <slug>-worst-times-to-visit.jpg
  <slug>-what-locals-do.jpg
  <slug>-add.jpg                   "A friend is visiting. Where do you take them?" (the post page)
  <slug>-take.jpg                  a shared take: "A <City> local says…" True / Nope
  <slug>-email.jpg                 the lead question with no answer pills, for the top of a city email
                                   (the email puts real answer buttons under it)

A card whose headline is about one place shows that place. The lead-question cards
(<slug>.jpg and <slug>-email.jpg) use data/card-photos/<slug>.jpg when there is one, otherwise
the city photo; data/card-photos/index.json records which each city uses and why.
  home.jpg                         homepage
  cities.jpg                       the Cities page

Run after adding a city, a question or a photo, then commit assets/og/:
    python3 scripts/og_cards.py              # everything
    python3 scripts/og_cards.py nashville    # one city's cards (+ home and cities)
"""
import io, json, os, sys, textwrap, urllib.request
from PIL import Image, ImageDraw, ImageFont

SB = "https://nkxorlktzbgwqnfwmuus.supabase.co"
KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB"  # public read key
HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "fonts", "Archivo.ttf")
MARK = os.path.join(HERE, "..", "assets", "brand", "mark-512.png")
OUT = os.path.join(HERE, "..", "assets", "og")
CARD_PHOTOS = os.path.join(HERE, "..", "data", "card-photos")
W, H, PAD = 1200, 630, 64
CORAL, INK, WHITE, SOFT = (255, 86, 48), (22, 20, 15), (255, 255, 255), (232, 226, 214)
JPEG = dict(quality=80, optimize=True, progressive=True)

THEMES = {
    "what-not-to-do": ("What not to do in {c}", "The mistakes visitors make, voted on by people who live there."),
    "worst-times-to-visit": ("Worst times to visit {c}", "The weeks to skip, and when to come instead."),
    "what-locals-do": ("What locals actually do in {c}", "Where people who know it take their friends. Never on the top-10 lists."),
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
    bw = d.textlength("TripVibz.com", font=bf)
    d.text((right, y + 25), "TripVibz.com", font=bf, fill=WHITE, anchor="rm")
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



# ------------------------------------------------- centre-safe layout
# Facebook shows a link's picture two ways: the whole 1200x630 card in a post, and a small
# square cut from the MIDDLE of it beside a link in a comment (TripVibz reels put their link
# in the first comment). Left-aligned cards came out as "...would / ...ke a / ?" in that
# square (19 Nov 2026). Cards a person is likely to paste in a comment keep everything that
# matters inside the middle square, centred, so both crops read.
SAFE = 630                      # the middle square Facebook keeps
SAFE_W = SAFE - 2 * 28          # widest line of type inside it
CX = W // 2


def shade_centre(base, mid=190, edge=95):
    """Darken most in the middle column, where the type sits."""
    m = Image.new("L", base.size)
    d = ImageDraw.Draw(m)
    half = SAFE / 2
    for x in range(base.width):
        t = min(1.0, max(0.0, (abs(x - CX) - half * 0.75) / (CX - half * 0.75)))
        d.line([(x, 0), (x, base.height)], fill=int(mid - (mid - edge) * t))
    return Image.composite(Image.new("RGB", base.size, INK), base, m)


def c_kicker(d, text, y, fill=CORAL):
    size = 26
    while d.textlength(text, font=font(size, 800)) + 40 > SAFE_W and size > 16:
        size -= 1
    kf = font(size, 800); kw = d.textlength(text, font=kf)
    d.rounded_rectangle([CX - kw / 2 - 20, y, CX + kw / 2 + 20, y + 50], radius=25, fill=fill)
    d.text((CX, y + 25), text, font=kf, fill=WHITE, anchor="mm")


def c_brand(base, d, y, size=26):
    bf = font(size, 800); bw = d.textlength("TripVibz.com", font=bf); mw = size * 2
    x = int(CX - (mw + 12 + bw) / 2)
    mark = Image.open(MARK).convert("RGBA").resize((mw, mw), Image.LANCZOS)
    base.paste(mark, (x, y), mark)
    d.text((x + mw + 12, y + mw // 2), "TripVibz.com", font=bf, fill=WHITE, anchor="lm")


def c_headline(d, text, y, lines=5, sizes=(64, 60, 56, 52, 48, 44, 40), color=WHITE):
    f, ls, size = fit(d, text, SAFE_W, lines, sizes)
    lh = int(size * 1.12)
    for l in ls:
        d.text((CX, y), l, font=f, fill=color, anchor="ma")
        y += lh
    return y


def chip_rows(d, labels, of, max_w=SAFE_W, gap=12):
    """Lay pills out in centred rows no wider than the safe square."""
    rows, row, w = [], [], 0
    for t in labels:
        tw = d.textlength(t, font=of) + 40
        if row and w + gap + tw > max_w:
            rows.append((row, w)); row, w = [], 0
        row.append((t, tw)); w += tw + (gap if len(row) > 1 else 0)
    if row:
        rows.append((row, w))
    return rows


def c_chips(d, labels, y, size=26, solid=None, gap=12, h=50):
    of = font(size, 700)
    for row, w in chip_rows(d, labels, of, gap=gap):
        x = CX - w / 2
        for t, tw in row:
            if solid and t in solid:
                d.rounded_rectangle([x, y, x + tw, y + h], radius=h // 2, fill=solid[t])
                d.text((x + tw / 2, y + h / 2), t, font=of, fill=INK if solid[t] == WHITE else WHITE, anchor="mm")
            else:
                d.rounded_rectangle([x, y, x + tw, y + h], radius=h // 2, outline=WHITE, width=3)
                d.text((x + tw / 2, y + h / 2), t, font=of, fill=WHITE, anchor="mm")
            x += tw + gap
        y += h + 10
    return y


# ---------------------------------------------------------------- card types

def card_question(city, q, pb):
    """Centre-safe: this is the card behind a city link, and reels put that link in a comment."""
    base = shade_centre(cover(Image.open(io.BytesIO(pb)))); d = ImageDraw.Draw(base)
    c_kicker(d, f"SETTLE THIS FOR {city['name'].upper()}", 40)
    labels = [o["label"] for o in q["options"][:3]]
    rows = len(chip_rows(d, labels, font(26, 700)))
    bottom = H - 96 - rows * 60                      # pills sit above the brand line
    # The largest type whose lines fit both the safe width and the room between the label and the pills.
    sizes = (64, 60, 56, 52, 48, 44, 40, 36)
    for i in range(len(sizes)):
        f, ls, size = fit(d, q["prompt"], SAFE_W, 6, sizes[i:])
        if len(ls) * int(size * 1.12) <= bottom - 112 - 8:
            break
    y = 112 + max(0, (bottom - 112 - len(ls) * int(size * 1.12)) // 2)
    c_headline(d, q["prompt"], y, lines=6, sizes=(size,))
    c_chips(d, labels, bottom + 6)
    c_brand(base, d, H - 78)
    return base


def card_email(city, q, pb):
    """The question card for the top of a city email. No answer pills: an email image is one link,
    so pills drawn on it can't be tapped, and the email's own buttons sit right under the picture."""
    base = photo_base(pb); d = ImageDraw.Draw(base)
    kicker(d, f"SETTLE THIS FOR {city['name'].upper()}"); brand(base, d)
    headline(d, q["prompt"], PAD + 100, sizes=(84, 78, 72, 66, 60, 54, 48))
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
    kicker(d, f"KNOW {city['name'].upper()}?"); brand(base, d)
    y = headline(d, "A friend is visiting. Where do you take them?", PAD + 90, lines=3, sizes=(88, 80, 72, 64))
    subline(d, "Say it in one sentence. Others vote it True or Nope.", y + 14)
    chips(d, ["I'd take them to ___", "Skip ___. Go to ___ instead."])
    return base


def card_take(city, pb):
    base = photo_base(pb); d = ImageDraw.Draw(base)
    kicker(d, f"A {city['name'].upper()} LOCAL SAYS"); brand(base, d)
    d.text((PAD - 4, PAD + 50), "“", font=font(190, 900), fill=CORAL)
    y = headline(d, "Is this true, or nope?", PAD + 190, lines=2, sizes=(84, 76, 70))
    subline(d, "People are voting. Tap to see the take and add yours.", y + 10)
    chips(d, ["True", "Nope"], solid={"True": WHITE, "Nope": CORAL}, size=32)
    return base


def card_home(cities, photos, leads):
    """Centre-safe: the words sit in the middle square, two city photos stacked on each side."""
    base = Image.new("RGB", (W, H), INK)
    tw, th = (W - SAFE) // 2, H // 2
    lf = font(22, 800)
    for i, slug in enumerate(HOME_CITIES):
        if slug not in photos:
            continue
        tile = cover(Image.open(io.BytesIO(photos[slug])), tw, th)
        tile = Image.composite(Image.new("RGB", tile.size, INK), tile, Image.new("L", tile.size, 70))
        x, y = (0 if i % 2 == 0 else W - tw), (i // 2) * th
        base.paste(tile, (x, y))
        name = next(c["name"] for c in cities if c["slug"] == slug)
        ImageDraw.Draw(base).text((x + 16, y + th - 20), name, font=lf, fill=WHITE, anchor="ls")
    d = ImageDraw.Draw(base)
    c_brand(base, d, 52, size=30)
    y = c_headline(d, "Where would you take a friend?", 150, lines=3, sizes=(72, 66, 60, 54))
    # Two real lead questions as poll chips.
    qf = font(23, 700)
    y = max(y + 22, 392)
    for q in leads[:2]:
        t = q
        while d.textlength(t, font=qf) + 36 > SAFE_W:
            t = t[:-2].rstrip() + "…"
        w = d.textlength(t, font=qf)
        d.rounded_rectangle([CX - w / 2 - 18, y, CX + w / 2 + 18, y + 48], radius=24, outline=WHITE, width=2)
        d.text((CX, y + 24), t, font=qf, fill=WHITE, anchor="mm")
        y += 58
    d.text((CX, H - 34), "Ask someone who knows.", font=font(24, 700), fill=CORAL, anchor="ms")
    return base


def card_cities(cities, photos):
    base = Image.new("RGB", (W, H), INK)
    picks = [c["slug"] for c in cities if c["slug"] in photos][:8]
    tw, th = W // 4, H // 2
    for i, slug in enumerate(picks):
        tile = cover(Image.open(io.BytesIO(photos[slug])), tw, th)
        base.paste(tile, ((i % 4) * tw, (i // 4) * th))
    base = shade_centre(base, mid=225, edge=130)
    d = ImageDraw.Draw(base)
    c_kicker(d, f"{len(cities)} CITIES AND COUNTING", 40)
    y = c_headline(d, "Pick your city. Where would you take a friend?", 150, lines=4, sizes=(66, 60, 56, 52))
    f, ls, sz = fit(d, "Don't see yours? One tap to ask for it.", SAFE_W, 2, (28, 26, 24), weight=600)
    for l in ls:
        d.text((CX, y + 18), l, font=f, fill=SOFT, anchor="ma"); y += int(sz * 1.3)
    c_brand(base, d, H - 78)
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
            # The lead question's cards show the place the question is about, when there is a photo of it.
            pp = os.path.join(CARD_PHOTOS, c["slug"] + ".jpg")
            qb = open(pp, "rb").read() if os.path.exists(pp) else pb
            save(card_question(c, mine[0], qb), f"{c['slug']}.jpg")
            save(card_email(c, mine[0], qb), f"{c['slug']}-email.jpg")
            meta[c["slug"]] = {"prompt": mine[0]["prompt"]}
        for t in THEMES:
            save(card_theme(c, t, pb), f"{c['slug']}-{t}.jpg")
        save(card_add(c, pb), f"{c['slug']}-add.jpg")
        save(card_take(c, pb), f"{c['slug']}-take.jpg")
        print(f"  {c['slug']}: 7 cards")
    leads = [next((q["prompt"] for q in qs if q["city_id"] == c["id"]), None) for c in cities if c["slug"] in ("chicago", "seattle")]
    save(card_home(cities, photos, [l for l in leads if l]), "home.jpg")
    save(card_cities(cities, photos), "cities.jpg")
    json.dump(dict(sorted(meta.items())), open(meta_path, "w"), indent=2)
    print("  home.jpg, cities.jpg")


if __name__ == "__main__":
    main(set(sys.argv[1:]))
