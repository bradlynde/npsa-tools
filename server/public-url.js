// Fetching a URL someone else chose, without reaching anything private.
//
// The pre-call research reads the organisation's website, and the address comes
// off the booking form: whoever books the call types it. Fetched as given, from
// this server, it could name the server itself, the Railway private network or
// the cloud metadata address, and a public site could redirect there just as well.
// So before every request, including each redirect hop, the host is resolved and
// refused unless every address it resolves to is public.
//
//   const r = await fetchPublic(url, { headers, signal })   // a Response, or throws
//
// A refusal throws an Error with code 'NOT_PUBLIC'.

import dns from 'dns';
import net from 'net';

const MAX_HOPS = 5;
// Replaceable by the checks, which run with no DNS (__test.setLookup).
let defaultLookup = (host, opts) => dns.promises.lookup(host, opts);

const blocked4 = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, cloud metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, and broadcast
]) blocked4.addSubnet(addr, bits, 'ipv4');

const blocked6 = new net.BlockList();
for (const [addr, bits] of [
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // site-local (deprecated, still routed by some stacks)
  ['ff00::', 8],         // multicast
  ['2001::', 32],        // Teredo
  ['2001:db8::', 32],    // documentation
]) blocked6.addSubnet(addr, bits, 'ipv6');

/** An IPv6 address as eight 16-bit words, or null if it is not one. */
function words6(addr) {
  let a = String(addr).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!net.isIPv6(a)) return null;
  // A trailing dotted quad is two words.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (quad) {
    const [b0, b1, b2, b3] = quad.slice(1).map(Number);
    a = a.slice(0, quad.index) + `${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map(x => parseInt(x, 16));
}

const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True only for an address that is routable on the public internet. */
export function isPublicAddress(addr) {
  const a = String(addr || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return !blocked4.check(a, 'ipv4');
  const w = words6(a);
  if (!w) return false;
  const zeros = n => w.slice(0, n).every(x => x === 0);
  // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d.
  if (zeros(6)) return false;
  // IPv4-mapped ::ffff:a.b.c.d and the NAT64 prefix 64:ff9b::/96 carry an IPv4
  // address, which is what is actually reached.
  if (zeros(5) && w[5] === 0xffff) return isPublicAddress(v4of(w[6], w[7]));
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every(x => x === 0)) return isPublicAddress(v4of(w[6], w[7]));
  // 6to4 2002:a.b.c.d::/48 likewise.
  if (w[0] === 0x2002) return isPublicAddress(v4of(w[1], w[2]));
  const canonical = w.map(x => x.toString(16)).join(':');
  return !blocked6.check(canonical, 'ipv6');
}

/** Names that never belong to a public site, whatever they resolve to. */
function privateName(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return !h || h === 'localhost' || /\.(localhost|internal|local|localdomain|home\.arpa)$/.test(h) || !h.includes('.');
}

function refuse(message) {
  const err = new Error(message);
  err.code = 'NOT_PUBLIC';
  return err;
}

/**
 * The URL, parsed, if it is http(s) on a public host; throws otherwise. Every
 * address the name resolves to must be public, not just the first.
 */
export async function assertPublicUrl(raw, { lookup = defaultLookup } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw refuse('not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw refuse(`${u.protocol} is not http or https`);
  if (u.username || u.password) throw refuse('a URL with credentials in it');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw refuse(`${host} is not a public address`);
    return u;
  }
  if (privateName(host)) throw refuse(`${host} is not a public host name`);
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); } catch (e) { throw refuse(`${host} does not resolve (${e.code || e.message})`); }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map(a => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (!list.length) throw refuse(`${host} does not resolve`);
  const bad = list.find(a => !isPublicAddress(a));
  if (bad) throw refuse(`${host} resolves to ${bad}, which is not public`);
  return u;
}

/**
 * fetch(), for a URL that must stay on the public internet. Redirects are followed
 * by hand, each hop checked the same way, at most MAX_HOPS of them. Returns the
 * final Response; a refusal throws.
 */
export async function fetchPublic(url, init = {}, { lookup, fetchImpl = fetch, maxHops = MAX_HOPS } = {}) {
  let current = String(url);
  for (let hop = 0; ; hop++) {
    const u = await assertPublicUrl(current, { lookup });
    const r = await fetchImpl(u.href, { ...init, redirect: 'manual' });
    const location = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!location) return r;
    if (hop >= maxHops) throw refuse(`more than ${maxHops} redirects`);
    // The body of a redirect is not wanted; let the connection go.
    try { await r.body?.cancel(); } catch { /* already closed */ }
    current = new URL(location, u).href;
  }
}

export const __test = {
  words6, privateName, MAX_HOPS,
  setLookup(fn) { defaultLookup = fn || ((host, opts) => dns.promises.lookup(host, opts)); },
};
