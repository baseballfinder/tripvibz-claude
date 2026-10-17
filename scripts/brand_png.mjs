// Renders the PNG sizes of the TripVibz logo from the SVGs in assets/brand/.
// Run after scripts/brand_assets.py:  node scripts/brand_png.mjs
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";

const DIR = "assets/brand";
// [output, source svg, width, height, background]
const JOBS = [
  ["favicon-16.png", "favicon.svg", 16, 16],
  ["favicon-32.png", "favicon.svg", 32, 32],
  ["favicon-48.png", "favicon.svg", 48, 48],
  ["apple-touch-icon.png", "mark-square.svg", 180, 180],   // iOS rounds the corners itself
  ["icon-192.png", "mark-square.svg", 192, 192],           // Android / web app
  ["icon-512.png", "mark-square.svg", 512, 512],
  ["google-oauth-120.png", "mark-rounded.svg", 120, 120],  // Google sign-in consent screen
  ["profile-1080.png", "mark-square.svg", 1080, 1080],     // Facebook / Instagram profile picture
  ["mark-512.png", "mark.svg", 512, 512],                  // round badge, transparent
  ["logo-600.png", "logo.svg", 600, null],                 // email header (1x)
  ["logo-1200.png", "logo.svg", 1200, null],               // email header (2x) / general
  ["logo-white-1200.png", "logo-white.svg", 1200, null],   // on dark backgrounds
];

const b = await chromium.launch();
const page = await b.newPage();
for (const [out, src, w, hIn] of JOBS) {
  const svg = await readFile(`${DIR}/${src}`, "utf8");
  const [, vw, vh] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const h = hIn || Math.round(w * vh / vw);
  await page.setViewportSize({ width: w, height: h });
  const sized = svg.replace(/width="[\d.]+" height="[\d.]+"/, `width="${w}" height="${h}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
  await page.screenshot({ path: `${DIR}/${out}`, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  console.log("  ", out, `${w}x${h}`);
}
await b.close();

// favicon.ico with 16/32/48 PNGs inside (PNG-in-ICO, supported everywhere).
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map(s => readFile(`${DIR}/favicon-${s}.png`)));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s, e); header.writeUInt8(s, e + 1); header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(pngs[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
await writeFile("favicon.ico", Buffer.concat([header, ...pngs]));
console.log("   favicon.ico (root)");
