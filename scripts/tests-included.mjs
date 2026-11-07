#!/usr/bin/env node
/**
 * "New code comes with tests": the rule behind the "tests-included" check
 * (.github/workflows/tests-required.yml) and CLAUDE.md.
 *
 * A pull request that changes site code must also change at least one test.
 * Site code is what the site does: the app pages, their scripts, the build,
 * the Cloudflare functions, the database migrations and the maintenance
 * scripts. Wording-only pages, data, images, styles, docs, workflows and
 * dependency files don't need a test. For a real exception, the PR gets the
 * "no-tests-needed" label.
 *
 * Tests are anything under tests/ except its README (the coverage table is
 * documentation, not a test), plus the Lighthouse configs.
 *
 *   git diff --name-only origin/main...HEAD | node scripts/tests-included.mjs
 *   (exit 0 = fine, 1 = code changed with no test change)
 */

export const LABEL = "no-tests-needed";

// App pages at the root (index.html, city.html, add.html…), not the text pages in folders (about/, privacy/).
const CODE = [
  /^[^/]+\.html$/,
  /^assets\/.+\.(m?js)$/,
  /^build\.mjs$/,
  /^lib\//,
  /^functions\//,
  /^supabase\/migrations\//,
  /^scripts\/.+\.(m?js|py|sh)$/
];
const TESTS = [/^tests\/(?!README\.md$).+/, /^lighthouserc(\.[a-z]+)?\.json$/];

export function classify(files) {
  const list = files.map(f => f.trim()).filter(Boolean);
  return {
    code: list.filter(f => CODE.some(r => r.test(f))),
    tests: list.filter(f => TESTS.some(r => r.test(f)))
  };
}

/** { ok, code, tests, reason } for a list of changed files and the PR's labels. */
export function check(files, labels = []) {
  const { code, tests } = classify(files);
  if (!code.length) return { ok: true, code, tests, reason: "no site code changed" };
  if (tests.length) return { ok: true, code, tests, reason: `${tests.length} test file${tests.length === 1 ? "" : "s"} changed` };
  if (labels.includes(LABEL)) return { ok: true, code, tests, reason: `"${LABEL}" label` };
  return { ok: false, code, tests, reason: "site code changed but no test did" };
}

// CLI: changed files on stdin, labels as a JSON array in PR_LABELS.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const files = readFileSync(0, "utf8").split("\n");
  let labels = [];
  try { labels = JSON.parse(process.env.PR_LABELS || "[]").map(l => (typeof l === "string" ? l : l.name)); } catch {}
  const r = check(files, labels);
  console.log(`Site code changed: ${r.code.length ? "\n  " + r.code.join("\n  ") : "none"}`);
  console.log(`Tests changed: ${r.tests.length ? "\n  " + r.tests.join("\n  ") : "none"}`);
  if (r.ok) { console.log(`OK: ${r.reason}.`); process.exit(0); }
  console.log(`::error title=Add a test::This pull request changes site code but no test. Add or update a test in tests/ ` +
    `for what changed (and a row in the coverage table in tests/README.md for a new feature). ` +
    `If it truly needs none (a pure refactor, a copy change inside a script), add the "${LABEL}" label and say why in the description.`);
  process.exit(1);
}
