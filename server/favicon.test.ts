import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { fetchFavicon, pickTries, pixelSize, rankIcons } from './favicon.ts';

/** The PNG header up to the size in IHDR — all sniffing and measuring look at. */
function png(width: number, height = width): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(head);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}
/** An ICO directory with entries of these sizes (256 is stored as 0). */
function ico(...sizes: number[]): Buffer {
  const dir = Buffer.alloc(6 + sizes.length * 16);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  sizes.forEach((s, i) => {
    dir[6 + i * 16] = s % 256;
    dir[7 + i * 16] = s % 256;
  });
  return dir;
}
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

const base = new URL('https://example.com/app/');
const urls = (html: string) => rankIcons(html, base).map((c) => c.url);

test('rankIcons: SVG, then mask-icon, then bigger rasters, /favicon.ico, apple-touch-icon last', () => {
  const html = `<!doctype html><html><head>
    <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
    <link rel="icon" type="image/png" sizes="16x16" href="/16.png">
    <link rel="icon" type="image/png" sizes="32x32" href="/32.png">
    <LINK REL="shortcut icon" href='/legacy.ico'>
    <link rel="mask-icon" href="/mask.svg" color="#000">
    <link rel="icon" href="icon.svg?v=2&amp;x=1" type="image/svg+xml">
    <link rel="stylesheet" href="/style.css">
  </head><body><link rel="icon" href="/body.png"></body></html>`;
  assert.deepEqual(urls(html), [
    'https://example.com/app/icon.svg?v=2&x=1',
    'https://example.com/mask.svg',
    'https://example.com/32.png',
    'https://example.com/16.png',
    'https://example.com/legacy.ico',
    'https://example.com/favicon.ico',
    'https://example.com/apple.png',
  ]);
});

test('rankIcons: no links, or no page at all, still leaves /favicon.ico', () => {
  assert.deepEqual(urls(''), ['https://example.com/favicon.ico']);
  assert.deepEqual(urls('<link rel="icon" href="data:image/png;base64,AAAA">'), ['https://example.com/favicon.ico']);
});

test('pickTries: small icons are not all there is — the touch icon nearest a useful size comes along (meetily.ai)', () => {
  const html = `<head>
    <link rel="icon" href="/app_icon.ico">
    <link rel="icon" sizes="16x16" href="/icon_16x16.png">
    <link rel="icon" sizes="32x32" href="/icon_32x32.png">
    <link rel="apple-touch-icon" sizes="128x128" href="/icon_128x128.png">
    <link rel="apple-touch-icon" sizes="512x512" href="/icon_512x512.png">
    <link rel="apple-touch-icon" sizes="1024x1024" href="/icon_512x512@2x.png">
  </head>`;
  assert.deepEqual(pickTries(rankIcons(html, base)), [
    'https://example.com/icon_32x32.png',
    'https://example.com/icon_16x16.png',
    'https://example.com/app_icon.ico',
    'https://example.com/favicon.ico',
    'https://example.com/icon_512x512.png',
  ]);
});

test('pixelSize: PNG and ICO measured, SVG unbounded, the rest unknown', () => {
  assert.equal(pixelSize({ body: png(48, 32), type: 'image/png' }), 48);
  assert.equal(pixelSize({ body: ico(16, 32, 256), type: 'image/x-icon' }), 256);
  assert.equal(pixelSize({ body: SVG, type: 'image/svg+xml' }), Number.POSITIVE_INFINITY);
  assert.equal(pixelSize({ body: Buffer.from('RIFF....WEBP'), type: 'image/webp' }), undefined);
});

const pages: Record<string, (res: ServerResponse) => void> = {
  // A site that redirects to www. and links its icon relative to the new location.
  '/': (res) => res.writeHead(301, { Location: '/www/' }).end(),
  '/www/': (res) =>
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<head>
      <link rel="apple-touch-icon" href="touch.png">
      <link rel="icon" href="broken.svg">
      <link rel="icon" sizes="128x128" href="mark.png">
    </head>`),
  '/www/touch.png': (res) => res.writeHead(200).end(png(180)),
  '/www/broken.svg': (res) => res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<html>not really</html>'),
  '/www/mark.png': (res) => res.writeHead(200).end(png(128)),
  '/favicon.ico': (res) => res.writeHead(200).end(ico(16, 32)),
  '/walled/': (res) => res.writeHead(403).end('bots go away'),
  '/svg/': (res) => res.writeHead(200).end('<link rel="icon" href="/svg/i.svg">'),
  '/svg/i.svg': (res) => res.writeHead(200).end(SVG),
  '/tiny/': (res) =>
    res.writeHead(200).end(`<link rel="icon" sizes="32x32" href="/tiny/32.png">
      <link rel="apple-touch-icon" sizes="256x256" href="/tiny/256.png">`),
  '/tiny/32.png': (res) => res.writeHead(200).end(png(32)),
  '/tiny/256.png': (res) => res.writeHead(200).end(png(256)),
};
const server = createServer((req, res) => (pages[req.url ?? ''] ?? ((r: ServerResponse) => r.writeHead(404).end()))(res));
let origin = '';
const local = { isAllowedAddress: (address: string) => address === '127.0.0.1', anyPort: true };

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('fetchFavicon: follows the redirect, skips a candidate that is not an image, a big enough icon beats the touch tile', async () => {
  const icon = await fetchFavicon(`${origin}/`, local);
  assert.equal(icon.from, `${origin}/www/mark.png`);
});

test('fetchFavicon: an SVG icon wins', async () => {
  const icon = await fetchFavicon(`${origin}/svg/`, local);
  assert.equal(icon.type, 'image/svg+xml');
});

test('fetchFavicon: only tiny icons — the bigger touch icon is taken instead', async () => {
  const icon = await fetchFavicon(`${origin}/tiny/`, local);
  assert.equal(icon.from, `${origin}/tiny/256.png`);
});

test('fetchFavicon: a page that refuses bots still yields /favicon.ico, small as it is', async () => {
  const icon = await fetchFavicon(`${origin}/walled/`, local);
  assert.equal(icon.type, 'image/x-icon');
  assert.equal(icon.from, `${origin}/favicon.ico`);
});

test('fetchFavicon: internal sites are refused like any other fetch', async () => {
  await assert.rejects(fetchFavicon(`${origin}/`, { anyPort: true }), /no usable favicon.*not a public address/);
});
