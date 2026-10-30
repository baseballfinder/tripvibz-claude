/**
 * Networks whose location says nothing about where a person lives: cloud and
 * hosting providers (where VPN exits, proxies and bots live) and Cloudflare's
 * own WARP egress. A check from one of these is recorded for admins with
 * band "hosting" and never counts as a presence day (functions/api/locate.js).
 *
 * Cloudflare gives us the connection's autonomous system number and name on
 * every request (request.cf.asn / asOrganization). This list is deliberately
 * short and conservative — a real local on a residential or mobile network is
 * never on it — and it is not published; the public page describes the rule,
 * not the list.
 */
const HOSTING_ASNS = new Set([
  16509, 14618,            // Amazon / AWS
  396982, 139070,          // Google Cloud (not 15169: Google Fi phones can appear there)
  8075, 8068, 8069,        // Microsoft / Azure
  13335,                   // Cloudflare (WARP, Workers)
  14061,                   // DigitalOcean
  63949,                   // Linode / Akamai Connected Cloud
  20940, 16625,            // Akamai
  54113,                   // Fastly
  16276,                   // OVH
  24940, 213230,           // Hetzner
  20473,                   // Vultr / Choopa
  9009,                    // M247 (many commercial VPNs)
  60068, 212238,           // Datacamp / CDN77 (NordVPN, Surfshark exits)
  60781, 28753,            // Leaseweb
  51167,                   // Contabo
  31898,                   // Oracle Cloud
  12876,                   // Scaleway
  21859,                   // Zenlayer
  136787,                  // PacketHub / TEFINCOM (NordVPN)
  62240, 39351, 9123,      // Clouvider, 31173 Services, TimeWeb — VPN hosts
  394711, 36352, 46562,    // Limenet, ColoCrossing, Performive
  3223, 29802, 40676       // Voxility, HIVELOCITY, Psychz
]);

// Name patterns for providers not pinned above. Word-bounded so "Cox
// Communications" or "Verizon Wireless" never match.
const HOSTING_NAMES = /\b(hosting|host|datacenter|data center|colocation|colo|cloud|server|servers|vpn|proxy|proxies|dedicated|vps)\b/i;

/** True when a request's network is a hosting/VPN provider rather than a home or mobile connection. */
export function isHostingNetwork(cf) {
  if (!cf) return false;
  const asn = Number(cf.asn);
  if (Number.isFinite(asn) && HOSTING_ASNS.has(asn)) return true;
  return HOSTING_NAMES.test(String(cf.asOrganization || ""));
}
