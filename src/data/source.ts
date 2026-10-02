import yaml from 'js-yaml';
import type { RadarData, RadarSource } from '../types.ts';
import { parseRadar } from './parse.ts';

/**
 * Loads a YAML (or JSON — it is valid YAML) document over HTTP.
 * Works for the local `public/radar.yaml` as well as any CORS-enabled URL:
 * a raw GitHub/GitLab file, a gist, an S3 bucket, etc.
 */
export class YamlUrlSource implements RadarSource {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  get label(): string {
    return this.url;
  }

  async load(): Promise<RadarData> {
    const response = await fetch(this.url, { cache: 'no-cache' });
    const text = await response.text();
    if (!response.ok) {
      const detail = response.headers.get('content-type')?.startsWith('text/plain') ? ` ${text.trim()}` : '';
      throw new Error(`Couldn’t load ${this.url}: HTTP ${response.status}.${detail}`);
    }
    let doc: unknown;
    try {
      doc = yaml.load(text);
    } catch (error) {
      throw new Error(`YAML syntax error in ${this.url}: ${(error as Error).message}`);
    }
    const data = parseRadar(doc);
    const warning = response.headers.get('X-Radar-Warning');
    if (warning) data.notice = decodeWarning(warning);
    // When the server knows when the Outline document was last edited, that
    // wins; `updated` in the YAML is only the fallback.
    const edited = new Date(response.headers.get('X-Radar-Updated') ?? '');
    if (!Number.isNaN(edited.getTime())) data.updated = edited;
    return data;
  }
}

/** The server sends the warning URL-encoded to keep the header ASCII. */
function decodeWarning(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * Picks the data source. Priority:
 *   1. `?source=<url>` in the page address — dev server only: in production it
 *      would let anyone send a link to your radar that renders their own content;
 *   2. `VITE_RADAR_SOURCE` at build time;
 *   3. `radar.yaml` next to the page.
 */
export function resolveSource(location: Location = window.location): RadarSource {
  const fromQuery = import.meta.env.DEV ? new URLSearchParams(location.search).get('source') : null;
  const url = fromQuery || import.meta.env.VITE_RADAR_SOURCE || `${import.meta.env.BASE_URL}radar.yaml`;
  return new YamlUrlSource(url);
}
