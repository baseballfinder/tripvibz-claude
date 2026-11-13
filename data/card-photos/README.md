# Card photos: the picture matches the place

A share card or email card whose headline is about one place shows that place.
"Little Havana: real local spot, or tourist trap now?" over a photo of Brickell
is the mistake this folder exists to prevent.

`index.json` has one entry per city, for the city's lead question (the one on
`assets/og/<slug>.jpg` and `assets/og/<slug>-email.jpg`):

| `photo` | Meaning |
|---|---|
| `place` | `<slug>.jpg` in this folder is a photo of the place; the cards use it. |
| `city` | The city photo already shows the place, or the question is about the whole city. Checked by eye. |
| `needed` | The question is about a place the city photo does not show. **Do not use this card in an email, ad or post until it has a photo.** |

`prompt` is the lead question the entry was checked against. `tests/static.mjs`
fails when a city's lead question no longer matches it, so a changed question
gets its photo looked at again.

To fix a `needed` city: add a photo you have the rights to as `<slug>.jpg`
(landscape, at least 1200 px wide), set `photo` to `place`, say where it came
from in `note`, run `python3 scripts/og_cards.py <slug>` and commit `assets/og/`.
