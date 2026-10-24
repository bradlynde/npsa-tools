#!/usr/bin/env node
/*
 * Public-URL guard check (server/public-url.js).
 *
 * The pre-call research fetches the website named on the booking form. This
 * checks, with no network and no DNS (both are stand-ins), that:
 *
 *   1. Addresses: public IPv4 and IPv6 pass; loopback, private, link-local, CGNAT,
 *      unique-local, multicast and the IPv6 forms that carry an IPv4 address
 *      (mapped, NAT64, 6to4) are judged by that address.
 *   2. URLs: only http and https, no credentials, no private host names, and a
 *      name passes only if every address it resolves to is public.
 *   3. Redirects are followed by hand and each hop is checked; too many is refused.
 *
 *   node scripts/public-url-smoke.mjs
 */
import assert from 'node:assert/strict';
import { isPublicAddress, assertPublicUrl, fetchPublic } from '../server/public-url.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

const DNS = {
  'olph1.org': ['93.184.215.14'],
  'v6.example.org': ['2606:4700::6810:84e5'],
  'split.example.org': ['93.184.215.14', '10.1.2.3'],
  'inside.example.org': ['127.0.0.1'],
  'mapped.example.org': ['::ffff:169.254.169.254'],
};
const lookup = async (host) => {
  const list = DNS[host];
  if (!list) { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e; }
  return list.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const refused = p => assert.rejects(p, e => e.code === 'NOT_PUBLIC');

await check('public addresses pass', () => {
  for (const a of ['93.184.215.14', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(a), true, a);
  }
});

await check('private, loopback, link-local and reserved addresses do not', () => {
  for (const a of [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '[::ffff:192.168.0.1]',
    '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '::127.0.0.1', 'not-an-ip',
  ]) assert.equal(isPublicAddress(a), false, a);
});

await check('only http and https URLs on public hosts', async () => {
  assert.equal((await assertPublicUrl('https://olph1.org/about', { lookup })).hostname, 'olph1.org');
  assert.equal((await assertPublicUrl('http://v6.example.org', { lookup })).hostname, 'v6.example.org');
  assert.equal((await assertPublicUrl('http://93.184.215.14/', { lookup })).hostname, '93.184.215.14');
  for (const u of [
    'file:///etc/passwd', 'ftp://olph1.org/', 'gopher://olph1.org/', 'https://user:pw@olph1.org/',
    'http://localhost:3001/api', 'http://app.localhost/', 'http://loe-generator.railway.internal/',
    'http://printer.local/', 'http://intranet/', 'http://127.0.0.1:3001/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://2130706433/', 'http://0x7f.1/',
    'https://inside.example.org/', 'https://mapped.example.org/', 'https://split.example.org/',
    'https://nowhere.example.org/', 'not a url',
  ]) await refused(assertPublicUrl(u, { lookup }));
});

await check('redirects are followed by hand, each hop checked', async () => {
  const seen = [];
  const hops = {
    'https://olph1.org/': { status: 301, location: '/home' },
    'https://olph1.org/home': { status: 302, location: 'https://v6.example.org/welcome' },
    'https://v6.example.org/welcome': { status: 200, body: 'hello' },
    'https://olph1.org/away': { status: 302, location: 'http://inside.example.org/admin' },
    'https://olph1.org/meta': { status: 307, location: 'http://169.254.169.254/' },
    'https://olph1.org/loop': { status: 302, location: '/loop' },
  };
  const fetchImpl = async (url, init) => {
    seen.push({ url, redirect: init.redirect });
    const h = hops[url];
    if (!h) return new Response('missing', { status: 404 });
    return new Response(h.body || '', { status: h.status, headers: h.location ? { location: h.location } : {} });
  };
  const r = await fetchPublic('https://olph1.org/', {}, { lookup, fetchImpl });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'hello');
  assert.deepEqual(seen.map(s => s.url), ['https://olph1.org/', 'https://olph1.org/home', 'https://v6.example.org/welcome']);
  assert.ok(seen.every(s => s.redirect === 'manual'), 'every request is sent with redirect: manual');

  seen.length = 0;
  await refused(fetchPublic('https://olph1.org/away', {}, { lookup, fetchImpl }));
  await refused(fetchPublic('https://olph1.org/meta', {}, { lookup, fetchImpl }));
  assert.ok(!seen.some(s => /inside|169\.254/.test(s.url)), 'a refused hop is never requested');

  seen.length = 0;
  await refused(fetchPublic('https://olph1.org/loop', {}, { lookup, fetchImpl, maxHops: 3 }));
  assert.equal(seen.length, 4, 'the first request and three redirects, then refused');
});

await check('a refused first address is never requested', async () => {
  let calls = 0;
  await refused(fetchPublic('http://127.0.0.1:3001/api/letters', {}, { lookup, fetchImpl: async () => { calls++; return new Response(''); } }));
  assert.equal(calls, 0);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll public-URL checks passed');
process.exit(failures ? 1 : 0);
