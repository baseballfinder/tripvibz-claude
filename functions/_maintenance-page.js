/**
 * The site-wide cover page shown while an update that changes the database is
 * going live (see functions/_middleware.js). Self-contained: no scripts (the
 * Content-Security-Policy would block an unhashed one), inline styles only, and
 * a meta refresh so an open tab comes back on its own once the update is done.
 */
export const MAINTENANCE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Back in a few minutes · TripVibz</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
    background:#fbfaf7;color:#16130e;font:16px/1.55 "Public Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:460px;text-align:center}
  .brand{display:inline-flex;align-items:center;gap:9px;font:900 22px/1 Archivo,system-ui,sans-serif;color:#16130e;text-decoration:none;margin-bottom:30px}
  .brand img{width:34px;height:34px}
  .k{font:700 12px/1 Archivo,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#c2410c;margin:0 0 12px}
  h1{font:900 clamp(28px,7vw,40px)/1.08 Archivo,system-ui,sans-serif;margin:0 0 14px}
  p{margin:0 0 10px;color:#39352d}
  .note{font-size:14px;color:#67625a;margin-top:22px}
</style>
</head>
<body>
<main>
  <a class="brand" href="/"><img src="/assets/brand/mark.svg" width="34" height="34" alt="">TripVibz</a>
  <p class="k">Updating</p>
  <h1>Back in a few minutes</h1>
  <p>We're putting new features live right now. Nothing you've posted is affected.</p>
  <p class="note">This page reloads itself every minute.</p>
</main>
</body>
</html>
`;
