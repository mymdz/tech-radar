/**
 * Checks that every icon in the radar file resolves to an image the browser
 * can process: reachable, an image, and served with CORS headers.
 *
 *   npm run check:icons                  # public/radar.yaml
 *   npm run check:icons -- path/to.yaml
 */
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { parseRadar } from '../src/data/parse.ts';
import { resolveIconUrl } from '../src/icons/resolve.ts';

const file = process.argv[2] ?? 'public/radar.yaml';
const data = parseRadar(yaml.load(await readFile(file, 'utf8')));

const results = await Promise.all(
  data.entries.map(async (entry) => {
    const url = resolveIconUrl(entry.icon, entry.links[0]?.url);
    if (!url || entry.iconMode === 'monogram') return { name: entry.name, ok: true, note: 'monogram' };
    try {
      const response = await fetch(url, { headers: { Origin: 'http://localhost' }, redirect: 'follow' });
      const type = response.headers.get('content-type') ?? '';
      const cors = response.headers.get('access-control-allow-origin');
      const problems = [
        !response.ok && `HTTP ${response.status}`,
        response.ok && !type.startsWith('image/') && `not an image (${type})`,
        !cors && 'no CORS header',
      ].filter(Boolean);
      return { name: entry.name, ok: problems.length === 0, note: problems.join(', ') || type, url };
    } catch (error) {
      return { name: entry.name, ok: false, note: (error as Error).message, url };
    }
  }),
);

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(18)} ${r.note}${r.ok ? '' : `\n      ${r.url}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} icons usable${failed ? ' — failed ones fall back to a monogram' : ''}.`);
process.exitCode = failed ? 1 : 0;
