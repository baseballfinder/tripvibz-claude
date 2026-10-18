# City questions: research loop

The "Locals, settle this" questions are the first thing a visitor taps and the
lead one is each city's Facebook share card, so every question has to be about
something people already search for and post about.

`spec.py` is the source of truth: 5 questions per city, lead first, each with the
searches people type for it and the hashtags they post under.

## Loop

1. **Edit `spec.py`.** Name the place the way people search it ("Red Rocks
   Amphitheatre", "Biltmore Estate"). Timing questions are "Best time to visit X?"
   (nobody searches "worst time"). Events carry the year ("Mardi Gras 2027").
2. **Search demand.** Actions → *Question keywords* → Run workflow. Needs the
   `BING_WM_API_KEY` secret. Results land in `data/keywords/<date>/<run>/`.
3. **Hashtags.** `python3 scripts/questions/research.py tags` prints a snippet; paste it
   into the console of an instagram.com tab you're signed into, wait ~2 seconds per
   tag, then `copy(JSON.stringify(window.__tags))` and save it as
   `data/keywords/<date>/hashtags.json`. Read-only; it reads public post counts.
4. **Score.** `python3 scripts/questions/research.py score data/keywords/<date>/<run> data/keywords/<date>/hashtags.json`
   → `data/keywords/question-scores.csv`. Replace anything "Not found"; move the
   strongest question to the lead unless it is a deliberate pick for social.
5. **Apply.** `python3 scripts/questions/research.py sql` prints SQL that makes the live
   questions match `spec.py`: rewordings keep their votes, removed questions are
   retired (`active = false`), new ones are inserted. Then
   `python3 scripts/og_cards.py` and commit `assets/og/`.

## Reading the numbers

- **Bing searches/month**: how often Bing showed results for that exact search,
  averaged over the months Bing keeps (about 6). Bing is roughly 1 in 8 US desktop
  searches, so use it to compare questions, not as real traffic. Below about 30 a
  month Bing reports zero.
- **Instagram posts**: total public posts ever made with the hashtag. Big generic
  tags (#miami) dwarf specific ones; compare within a city.
