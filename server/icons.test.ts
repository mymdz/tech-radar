import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { IconSource } from '../src/icons/resolve.ts';
import type { Icon } from './icon-fetch.ts';
import { IconCache, iconSources } from './icons.ts';

const quiet = () => {};
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const radar = (...entries: string[]) => `rings:
  - name: Adopt
sectors:
  - name: A
  - name: B
entries:
${entries.map((e) => `  - ring: adopt\n    sector: a\n${e}`).join('\n')}`;

const GO = '    name: Go\n    icon: simple-icons:go';
const GRAFANA = '    name: Grafana\n    links:\n      - url: https://grafana.com/docs';
const MONO = '    name: Mono\n    icon: favicon:mono.dev\n    iconMode: monogram';
const LOCAL = '    name: Local\n    icon: /icons/local.svg';

const GO_URL = 'https://cdn.simpleicons.org/go';
const GRAFANA_URL = 'https://icon.horse/icon/grafana.com';

async function withCache(run: (cache: IconCache, dir: string, calls: string[], fail: Set<string>) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'icons-'));
  const calls: string[] = [];
  const fail = new Set<string>();
  const fetch = async ({ url }: IconSource): Promise<Icon> => {
    calls.push(url);
    if (fail.has(url)) throw new Error('HTTP 404');
    return { body: PNG, type: 'image/png' };
  };
  try {
    await run((await IconCache.open(dir, quiet, fetch))!, dir, calls, fail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('iconSources: what the page would fetch — favicon fallback, no monograms, no relative paths', () => {
  assert.deepEqual(
    [...iconSources(radar(GO, GRAFANA, MONO, LOCAL)).values()],
    [{ url: GO_URL }, { url: GRAFANA_URL, site: 'grafana.com' }],
  );
});

test('favicons fetched another way (icon.horse) are replaced by ones from the site', async () => {
  await withCache(async (cache, dir) => {
    // What the previous version stored: named by the icon.horse URL.
    const old = createHash('sha256').update(GRAFANA_URL).digest('hex');
    await writeFile(path.join(dir, old), PNG);

    await cache.follow(radar(GRAFANA));
    const names = await readdir(dir);
    assert.equal(names.length, 1);
    assert.notEqual(names[0], old);
  });
});

test('only icons of the current radar are fetched; others are not even tried', async () => {
  await withCache(async (cache, _dir, calls) => {
    await cache.follow(radar(GO));
    assert.equal(cache.allows('http://169.254.169.254/latest/meta-data'), false);
    assert.equal(await cache.get('http://169.254.169.254/latest/meta-data'), undefined);
    assert.deepEqual(calls, [GO_URL]); // the warm-up only
  });
});

test('a new radar warms its icons; later requests and restarts read the disk', async () => {
  await withCache(async (cache, dir, calls) => {
    await cache.follow(radar(GO, GRAFANA));
    assert.deepEqual(calls.sort(), [GO_URL, GRAFANA_URL]);

    assert.deepEqual(await cache.get(GO_URL), { body: PNG, type: 'image/png' });
    const restarted = (await IconCache.open(dir, quiet, async () => assert.fail('should come from disk')))!;
    await restarted.follow(radar(GO, GRAFANA));
    assert.deepEqual(await restarted.get(GRAFANA_URL), { body: PNG, type: 'image/png' });
    assert.equal(calls.length, 2);
  });
});

test('icons dropped from the radar are deleted; foreign files are left alone', async () => {
  await withCache(async (cache, dir) => {
    await writeFile(path.join(dir, 'README'), 'not ours');
    await cache.follow(radar(GO, GRAFANA));
    assert.equal((await readdir(dir)).length, 3);

    await cache.follow(radar(GO));
    const left = await readdir(dir);
    assert.equal(left.length, 2);
    assert.ok(left.includes('README'));
  });
});

test('a failed icon is not retried on every request', async () => {
  await withCache(async (cache, _dir, calls, fail) => {
    fail.add(GO_URL);
    await cache.follow(radar(GO));
    assert.equal(await cache.get(GO_URL), undefined);
    assert.equal(await cache.get(GO_URL), undefined);
    assert.equal(calls.length, 1);
  });
});

test('concurrent requests for one icon share one download', async () => {
  await withCache(async (cache, dir, calls) => {
    // Unchanged data doesn't sync again, so the files can be removed under it.
    await cache.follow(radar(GO));
    for (const name of await readdir(dir)) await rm(path.join(dir, name));
    calls.length = 0;

    const results = await Promise.all([cache.get(GO_URL), cache.get(GO_URL), cache.get(GO_URL)]);
    assert.ok(results.every((r) => r?.type === 'image/png'));
    assert.equal(calls.length, 1);
  });
});
