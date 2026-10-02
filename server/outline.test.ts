import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { extractYaml, fetchDocument } from './outline.ts';

test('extractYaml: block among notes', () => {
  assert.equal(extractYaml('Заметки\n\n```yaml\ntitle: Radar\nrings: []\n```\n\nИ снизу'), 'title: Radar\nrings: []\n');
});

test('extractYaml: yml tag and tilde fence', () => {
  assert.equal(extractYaml('~~~yml\na: 1\n~~~\n'), 'a: 1\n');
});

test('extractYaml: first yaml block wins, other languages skipped', () => {
  assert.equal(extractYaml('```go\nx := 1\n```\n```yaml\nfirst: true\n```\n```yaml\nsecond: true\n```'), 'first: true\n');
});

test('extractYaml: backticks inside a value do not close the block', () => {
  assert.equal(extractYaml('```yaml\ndescription: use `code` here\n```'), 'description: use `code` here\n');
});

test('extractYaml: crlf', () => {
  assert.equal(extractYaml('```yaml\r\na: 1\r\n```\r\n'), 'a: 1\n');
});

test('extractYaml: missing or unclosed block', () => {
  assert.throws(() => extractYaml('just text'), /no ```yaml block/);
  assert.throws(() => extractYaml('```yaml\na: 1\n'), /never closed/);
});

test('fetchDocument: id with token or public share, updatedAt when Outline reveals it', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { id, shareId } = JSON.parse(body) as { id?: string; shareId?: string };
      const ok = (data: object) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
      if (req.url !== '/api/documents.info') {
        res.writeHead(404).end('{"error":"not_found"}');
      } else if (shareId === 'share-1') {
        // A public share without "Show last modified": no updatedAt at all.
        ok({ text: 'shared' });
      } else if (req.headers.authorization !== 'Bearer secret') {
        res.writeHead(401).end('{"error":"authentication_required"}');
      } else if (id !== 'doc-1') {
        res.writeHead(404).end('{"error":"not_found"}');
      } else {
        ok({ text: 'hello', updatedAt: '2026-09-30T10:00:00.000Z' });
      }
    });
  });
  // Bind the same address we call: listening on all interfaces let another
  // process on the same random IPv4 port answer instead (a flaky 404).
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  try {
    assert.deepEqual(await fetchDocument({ baseUrl, token: 'secret', documentId: 'doc-1' }), { text: 'hello', updatedAt: '2026-09-30T10:00:00.000Z' });
    assert.deepEqual(await fetchDocument({ baseUrl, shareId: 'share-1' }), { text: 'shared', updatedAt: undefined });
    await assert.rejects(fetchDocument({ baseUrl, token: 'wrong', documentId: 'doc-1' }), /401/);
    await assert.rejects(fetchDocument({ baseUrl, token: 'secret', documentId: 'nope' }), /404.*not_found/);
  } finally {
    server.close();
  }
});
