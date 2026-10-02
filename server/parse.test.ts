import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRadar, RadarDataError } from '../src/data/parse.ts';

const radar = (ringColor: string, sectorColor = '#123456') => ({
  rings: [{ name: 'Adopt', color: ringColor }],
  sectors: [{ name: 'A', color: sectorColor }, { name: 'B' }],
  entries: [{ name: 'Go', ring: 'adopt', sector: 'a', link: 'javascript:alert(1)' }],
});

test('entry dates are shown as written; bare YAML dates come back as ISO days', async () => {
  const yaml = (await import('js-yaml')).default;
  const data = parseRadar(
    yaml.load(`
rings: [{name: Adopt}]
sectors: [{name: A}, {name: B}]
entries:
  - {name: Go, ring: adopt, sector: a, added: сентябрь 2026, updated: 2026-10-01}
  - {name: Rust, ring: adopt, sector: b, added: 2026}
  - {name: Zig, ring: adopt, sector: b}
`),
  );
  assert.deepEqual(
    data.entries.map((e) => [e.added, e.updated]),
    [['сентябрь 2026', '2026-10-01'], ['2026', undefined], [undefined, undefined]],
  );
});

test('plain CSS colors are accepted', () => {
  for (const color of ['#4fd1a1', '#fff', '#0e0b0bcc', 'teal', 'rgb(10, 20, 30)', 'hsl(250deg 60% 50% / 0.5)', 'oklch(0.6 0.15 250)']) {
    assert.equal(parseRadar(radar(color)).rings[0].color, color);
  }
});

test('anything that could inject CSS is rejected, naming the field', () => {
  for (const color of ['red;background:url(https://evil.example/x)', 'url(https://evil.example/x)', 'var(--x)', 'red}body{display:none', 'rgb(1,2,3);x:y']) {
    assert.throws(
      () => parseRadar(radar(color)),
      (error: unknown) => error instanceof RadarDataError && error.problems.some((p) => p.startsWith('rings[0]: color')),
      color,
    );
    assert.throws(() => parseRadar(radar('#fff', color)), /sectors\[0\]: color/, color);
  }
});
