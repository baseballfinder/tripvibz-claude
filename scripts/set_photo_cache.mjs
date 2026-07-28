/**
 * One-time: re-upload the resized city photos with a 30-day Cache-Control.
 *
 * Supabase sets cache-control at upload time and the dashboard uploader
 * doesn't expose the field, so this re-uploads the 7 files from
 * city-photos-out/ with cacheControl set. Only needed if you want a longer
 * browser cache than the 1-hour default — it does not affect Core Web Vitals.
 *
 * Requires the SERVICE ROLE key (never commit it; never ship it to the
 * browser). Get it from Supabase → Project Settings → API → service_role.
 *
 *   SUPABASE_SERVICE_KEY=xxxx node scripts/set_photo_cache.mjs
 *
 * Needs @supabase/supabase-js:  npm i @supabase/supabase-js
 */
import { createClient } from "@supabase/supabase-js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const URL = "https://nkxorlktzbgwqnfwmuus.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_KEY;
const DIR = "city-photos-out";
const CACHE = "2592000"; // 30 days, seconds

if (!KEY) {
  console.error("Set SUPABASE_SERVICE_KEY (service_role, from Project Settings → API).");
  process.exit(1);
}

const sb = createClient(URL, KEY);
const files = (await readdir(DIR)).filter(f => f.endsWith(".webp"));
if (!files.length) { console.error(`No .webp files in ${DIR}/`); process.exit(1); }

for (const f of files) {
  const bytes = await readFile(join(DIR, f));
  const { error } = await sb.storage.from("city-photos")
    .upload(f, bytes, { cacheControl: CACHE, upsert: true, contentType: "image/webp" });
  console.log(error ? `  ✗ ${f}: ${error.message}` : `  ✓ ${f}  (cache ${CACHE}s)`);
}
console.log("Done.");
