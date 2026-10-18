#!/usr/bin/env python3
"""
Facebook / social share cards for city pages.

For each city with an active question, draws a 1200x630 JPEG: the city photo,
darkened, with "<City> locals, settle this" and the hook question on top.
Writes assets/og/<slug>.jpg plus assets/og/cards.json, which build.mjs reads
to set og:image, og:title and og:description for the city and vote pages.

Run after adding a city, a question or a photo, then commit assets/og/:
    python3 scripts/og_cards.py              # all cities with questions
    python3 scripts/og_cards.py knoxville    # just one

HOOK picks which question sells the city on social (default: sort order 1).
"""
import io, json, os, sys, textwrap, urllib.request
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SB = "https://nkxorlktzbgwqnfwmuus.supabase.co"
KEY = "sb_publishable_5UOevsS8KmWWGrQYNWsabg_0sVOIPmB"  # public read key
FONT = os.path.join(os.path.dirname(__file__), "fonts", "Archivo.ttf")
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "og")
W, H = 1200, 630
CORAL, INK, PAPER = (255, 86, 48), (22, 20, 15), (251, 250, 247)

# The lead question (lowest sort) is the hook; order lives in scripts/questions/spec.py.
HOOK = {}


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


def cover(im):
    im = im.convert("RGB")
    s = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - W) // 2, (im.height - H) // 2
    return im.crop((x, y, x + W, y + H))


def fit(draw, text, max_w, max_lines, sizes):
    for size in sizes:
        f = font(size, 900)
        avg = draw.textlength("abcdefghijklmnopqrstuvwxyz", font=f) / 26
        lines = textwrap.wrap(text, width=max(8, int(max_w / avg)))
        while lines and max(draw.textlength(l, font=f) for l in lines) > max_w:
            avg *= 1.05
            lines = textwrap.wrap(text, width=max(8, int(max_w / avg)))
        if len(lines) <= max_lines:
            return f, lines, size
    return f, lines[:max_lines], size


def card(city, q, photo_bytes):
    base = cover(Image.open(io.BytesIO(photo_bytes)))
    # Darken toward the text side so white type always reads.
    shade = Image.new("L", (W, H))
    sd = ImageDraw.Draw(shade)
    for x in range(W):
        sd.line([(x, 0), (x, H)], fill=int(200 - 135 * (x / W)))
    base = Image.composite(Image.new("RGB", (W, H), INK), base, shade)
    d = ImageDraw.Draw(base)

    pad = 64
    kicker = f"{city['name'].upper()} LOCALS, SETTLE THIS"
    kf = font(26, 800)
    kw = d.textlength(kicker, font=kf)
    d.rounded_rectangle([pad, pad, pad + kw + 40, pad + 50], radius=25, fill=CORAL)
    d.text((pad + 20, pad + 25), kicker, font=kf, fill=(255, 255, 255), anchor="lm")

    qf, lines, size = fit(d, q["prompt"], W - pad * 2 - 40, 4, [76, 70, 64, 58, 52, 48])
    lh = int(size * 1.12)
    y = pad + 50 + 40
    for l in lines:
        d.text((pad, y), l, font=qf, fill=(255, 255, 255))
        y += lh

    # Answer chips: shows at a glance it's a one-tap vote.
    of = font(28, 700)
    x, y = pad, H - pad - 56
    for o in q["options"][:3]:
        t = o["label"]
        tw = d.textlength(t, font=of)
        if x + tw + 44 > W - pad:
            break
        d.rounded_rectangle([x, y, x + tw + 44, y + 56], radius=28, outline=(255, 255, 255), width=3)
        d.text((x + 22, y + 28), t, font=of, fill=(255, 255, 255), anchor="lm")
        x += tw + 44 + 14

    bf = font(26, 800)
    brand = "TripVibz"
    bw = d.textlength(brand, font=bf)
    d.text((W - pad, pad + 25), brand, font=bf, fill=(255, 255, 255), anchor="rm")
    mark = Image.open(os.path.join(os.path.dirname(__file__), "..", "assets", "brand", "mark-512.png")).convert("RGBA").resize((52, 52), Image.LANCZOS)
    base.paste(mark, (int(W - pad - bw - 64), pad - 1), mark)
    return base


def main(only):
    cities = json.loads(get("/rest/v1/cities?select=id,name,state,slug,photo"))
    qs = json.loads(get("/rest/v1/questions?select=city_id,prompt,options,sort,active&active=eq.true&order=sort"))
    os.makedirs(OUT, exist_ok=True)
    meta_path = os.path.join(OUT, "cards.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    for c in cities:
        if only and c["slug"] not in only:
            continue
        mine = [q for q in qs if q["city_id"] == c["id"]]
        if not mine:
            continue
        q = next((x for x in mine if x["prompt"] == HOOK.get(c["slug"])), mine[0])
        photo = c.get("photo") or c["slug"] + ".webp"
        try:
            pb = get("/storage/v1/object/public/city-photos/" + urllib.request.quote(photo))
        except Exception as e:
            print(f"  skip {c['slug']}: no photo ({e})")
            continue
        card(c, q, pb).save(os.path.join(OUT, c["slug"] + ".jpg"), "JPEG", quality=84, optimize=True, progressive=True)
        meta[c["slug"]] = {"prompt": q["prompt"]}
        print(f"  {c['slug']}: {q['prompt']}")
    json.dump(dict(sorted(meta.items())), open(meta_path, "w"), indent=2)


if __name__ == "__main__":
    main(set(sys.argv[1:]))
