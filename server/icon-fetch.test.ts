import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { fetchIcon, isPublicAddress, sniffImageType } from './icon-fetch.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

const routes: Record<string, (res: ServerResponse) => void> = {
  '/icon.png': (res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG),
  '/favicon.ico': (res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(Buffer.from('00000100010010100000', 'hex')),
  '/page': (res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html><body>404</body></html>'),
  '/missing': (res) => res.writeHead(404).end(),
  '/declared-huge': (res) => res.writeHead(200, { 'Content-Length': String(10 * 1024 * 1024) }).end(),
  // Chunked, no Content-Length: only counting the bytes catches it.
  '/endless': (res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    const chunk = Buffer.alloc(64 * 1024);
    const pump = () => {
      while (res.write(chunk));
      res.once('drain', pump);
    };
    res.on('close', () => res.removeAllListeners('drain'));
    pump();
  },
  '/bomb': (res) => res.writeHead(200, { 'Content-Encoding': 'gzip' }).end(gzipSync(Buffer.alloc(20 * 1024 * 1024))),
  '/gzipped.svg': (res) => res.writeHead(200, { 'Content-Encoding': 'gzip' }).end(gzipSync(SVG)),
  '/slow': (res) => setTimeout(() => res.writeHead(200).end(PNG), 2_000),
  '/hop': (res) => res.writeHead(302, { Location: '/icon.png' }).end(),
  '/loop': (res) => res.writeHead(302, { Location: '/loop' }).end(),
  '/to-other-host': (res) => res.writeHead(302, { Location: `http://127.0.0.2:${port}/icon.png` }).end(),
};

const server = createServer((req, res) => (routes[req.url ?? ''] ?? routes['/missing'])(res));
let port = 0;
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** The local test server is on loopback and a random port; production allows neither. */
const local = { isAllowedAddress: (address: string) => address === '127.0.0.1', anyPort: true };

test('isPublicAddress: private, loopback, link-local, mapped and NAT64 are not public', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:a00:1', '64:ff9b::7f00:1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('sniffImageType: by signature, not by name or header', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(SVG), 'image/svg+xml');
  assert.equal(sniffImageType(Buffer.from('﻿  <!-- logo -->\n<svg viewBox="0 0 1 1"></svg>')), 'image/svg+xml');
  assert.equal(sniffImageType(Buffer.from('<html><body><svg></svg></body></html>')), undefined);
  assert.equal(sniffImageType(Buffer.from('{"error":"nope"}')), undefined);
  assert.equal(sniffImageType(Buffer.alloc(0)), undefined);
});

test('fetchIcon: images whatever their Content-Type, gzip undone, redirects followed', async () => {
  assert.deepEqual(await fetchIcon(`${base}/icon.png`, local), { body: PNG, type: 'image/png' });
  assert.equal((await fetchIcon(`${base}/favicon.ico`, local)).type, 'image/x-icon');
  assert.deepEqual(await fetchIcon(`${base}/gzipped.svg`, local), { body: SVG, type: 'image/svg+xml' });
  assert.equal((await fetchIcon(`${base}/hop`, local)).type, 'image/png');
});

test('fetchIcon: refuses what is not an image or not there', async () => {
  await assert.rejects(fetchIcon(`${base}/page`, local), /not an image/);
  await assert.rejects(fetchIcon(`${base}/missing`, local), /HTTP 404/);
  await assert.rejects(fetchIcon(`${base}/loop`, local), /too many redirects/);
});

test('fetchIcon: size is capped by the header, by the stream and after decompression', async () => {
  await assert.rejects(fetchIcon(`${base}/declared-huge`, local), /too large/);
  await assert.rejects(fetchIcon(`${base}/endless`, local), /larger than/);
  await assert.rejects(fetchIcon(`${base}/bomb`, local), /corrupt or larger than/);
});

test('fetchIcon: one deadline for the whole download', async () => {
  await assert.rejects(fetchIcon(`${base}/slow`, { ...local, timeoutMs: 200 }), /timeout|aborted/i);
});

test('fetchIcon: internal addresses are refused — literal, resolved, or after a redirect', async () => {
  const defaults = { anyPort: true };
  await assert.rejects(fetchIcon(`${base}/icon.png`, defaults), /127\.0\.0\.1 is not a public address/);
  await assert.rejects(fetchIcon(`http://localhost:${port}/icon.png`, defaults), /not a public address/);
  await assert.rejects(fetchIcon(`http://[::ffff:7f00:1]:${port}/icon.png`, defaults), /not a public address/);
  await assert.rejects(fetchIcon(`${base}/to-other-host`, local), /127\.0\.0\.2 is not a public address/);
});

test('fetchIcon: only http(s) on default ports, no credentials', async () => {
  await assert.rejects(fetchIcon('https://example.com:8443/icon.png'), /non-default ports/);
  await assert.rejects(fetchIcon('file:///etc/passwd'), /file: URLs are not fetched/);
  await assert.rejects(fetchIcon('https://user:pass@example.com/icon.png'), /credentials/);
});
