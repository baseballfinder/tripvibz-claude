/**
 * Old take links: /thread.html?id=<id> (Cloudflare first turns that into /thread?id=<id>).
 * Send them permanently to /t/<id>, the address Google should index. Without an id,
 * fall through to the static page.
 */
export async function onRequestGet({ request, next }) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (/^[0-9a-f-]{36}$/i.test(id)) return Response.redirect(new URL(`/t/${id}`, request.url).toString(), 301);
  return next();
}
