import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RadarSource } from './radar-source.ts';

const quiet = () => {};

const doc = (block: string) => `Заметки\n\n\`\`\`yaml\n${block}\n\`\`\`\n`;
const GOOD = `rings:
  - name: Adopt
sectors:
  - name: A
  - name: B
entries:
  - name: Go
    ring: adopt
    sector: a`;

function source(markdown: { current: string; updatedAt?: string }, calls = { count: 0 }, ttlMs = 60_000) {
  return new RadarSource(
    async () => {
      calls.count++;
      return { text: markdown.current, updatedAt: markdown.updatedAt };
    },
    ttlMs,
    quiet,
  );
}

test('serves the block and asks Outline once per TTL', async () => {
  const calls = { count: 0 };
  const radar = source({ current: doc(GOOD) }, calls);

  const [a, b] = await Promise.all([radar.current(), radar.current()]);
  await radar.current();

  assert.equal(a.body, `${GOOD}\n`);
  assert.equal(a.warning, undefined);
  assert.deepEqual(b, a);
  assert.equal(calls.count, 1);
});

test('falls back to the last good version on a YAML syntax error, recovers after a fix', async () => {
  const markdown = { current: doc(GOOD) };
  const radar = source(markdown, undefined, 0);
  await radar.current();

  markdown.current = doc('rings: [\n  - broken');
  const broken = await radar.current();
  assert.equal(broken.body, `${GOOD}\n`);
  assert.match(broken.warning ?? '', /YAML syntax error.*line/);

  markdown.current = doc(GOOD);
  assert.equal((await radar.current()).warning, undefined);
});

test('rejects data the page would reject, naming the entry', async () => {
  const markdown = { current: doc(GOOD) };
  const radar = source(markdown, undefined, 0);
  await radar.current();

  markdown.current = doc(GOOD.replace('ring: adopt', 'ring: adpot'));
  const { body, warning } = await radar.current();
  assert.equal(body, `${GOOD}\n`);
  assert.match(warning ?? '', /Go.*adpot/);
});

test('the edit date belongs to the served version: a rejected edit keeps the old date', async () => {
  const markdown = { current: doc(GOOD), updatedAt: '2026-09-29T10:00:00.000Z' };
  const radar = source(markdown, undefined, 0);
  assert.equal((await radar.current()).updatedAt, '2026-09-29T10:00:00.000Z');

  markdown.current = doc('rings: [');
  markdown.updatedAt = '2026-09-30T10:00:00.000Z';
  assert.equal((await radar.current()).updatedAt, '2026-09-29T10:00:00.000Z');

  markdown.current = doc(GOOD);
  markdown.updatedAt = '2026-09-30T11:00:00.000Z';
  assert.equal((await radar.current()).updatedAt, '2026-09-30T11:00:00.000Z');
});

test('no good version yet: no body, reason in the warning', async () => {
  const radar = source({ current: 'no yaml here' });
  const { body, warning } = await radar.current();
  assert.equal(body, undefined);
  assert.match(warning ?? '', /no ```yaml block/);
});
