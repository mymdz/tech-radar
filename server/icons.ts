import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseRadar } from '../src/data/parse.ts';
import { resolveIcon, type IconSource } from '../src/icons/resolve.ts';
import { fetchFavicon } from './favicon.ts';
import { fetchIcon, sniffImageType, type Icon } from './icon-fetch.ts';
import type { Log } from './log.ts';

const FRESH_MS = 7 * 24 * 60 * 60_000; // older copies are served, and refetched in the background
const RETRY_MS = 15 * 60_000; // a failed icon is not asked for again sooner than this
const PARALLEL = 4; // downloads at once: each holds up to MAX_ICON_BYTES in memory
const NAME = /^[0-9a-f]{64}$/;
const TMP = /^[0-9a-f]{64}\..+\.tmp$/;

/** The http(s) icons a radar file refers to, by the URL the page asks for — exactly what it would fetch. */
export function iconSources(radarYaml: string): Map<string, IconSource> {
  const sources = new Map<string, IconSource>();
  for (const entry of parseRadar(yaml.load(radarYaml)).entries) {
    if (entry.iconMode === 'monogram') continue;
    const source = resolveIcon(entry.icon, entry.links[0]?.url);
    if (source && /^https?:\/\//i.test(source.url)) sources.set(source.url, source);
  }
  return sources;
}

/** A site's favicon is looked up on the site; anything else is fetched as is. */
function fetchSource(source: IconSource): Promise<Icon> {
  return source.site ? fetchFavicon(`https://${source.site}/`) : fetchIcon(source.url);
}

/**
 * A file cache of the original icon images, one file per icon, as they came
 * from the source — the page still turns them into glyphs.
 *
 * Only icons from the current radar data are served or fetched, so this is not
 * an open proxy; files of icons the data no longer uses are deleted, so the
 * directory stays as big as the radar.
 */
export class IconCache {
  private readonly dir: string;
  private readonly log: Log;
  private readonly fetch: (source: IconSource) => Promise<Icon>;
  private radarYaml: string | undefined;
  private allowed = new Map<string, IconSource>();
  private readonly pending = new Map<string, Promise<Icon | undefined>>();
  private readonly failedAt = new Map<string, number>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  private constructor(dir: string, log: Log, fetch: (source: IconSource) => Promise<Icon>) {
    this.dir = dir;
    this.log = log;
    this.fetch = fetch;
  }

  /** Undefined when the directory can't be created: the page then fetches icons itself. */
  static async open(dir: string, log: Log, fetch: (source: IconSource) => Promise<Icon> = fetchSource): Promise<IconCache | undefined> {
    try {
      await mkdir(dir, { recursive: true });
      return new IconCache(path.resolve(dir), log, fetch);
    } catch (error) {
      log('error', 'icon cache disabled: no cache directory', { dir, error: String(error) });
      return undefined;
    }
  }

  /**
   * Takes the icon list from this radar file; a new list prunes old files and
   * warms new ones. Never rejects; callers need not wait for it.
   */
  async follow(radarYaml: string): Promise<void> {
    if (radarYaml === this.radarYaml) return;
    this.radarYaml = radarYaml;
    try {
      this.allowed = iconSources(radarYaml);
    } catch (error) {
      this.allowed = new Map();
      this.log('warn', 'icon cache: radar data unreadable', { error: String(error) });
    }
    await this.sync().catch((error) => this.log('warn', 'icon cache sync failed', { error: String(error) }));
  }

  allows(url: string): boolean {
    return this.allowed.has(url);
  }

  /** The cached copy (even a stale one), else a fresh download; undefined if neither works. */
  async get(url: string): Promise<Icon | undefined> {
    const source = this.allowed.get(url);
    if (!source) return undefined;
    const cached = await this.read(source);
    if (!cached) return this.refresh(source);
    if (cached.age > FRESH_MS) void this.refresh(source);
    return cached.icon;
  }

  private async sync() {
    const keep = new Set([...this.allowed.values()].map(fileName));
    for (const name of await readdir(this.dir)) {
      // Only our own files: never touch anything else that lives in the directory.
      const stale = (NAME.test(name) && !keep.has(name)) || (TMP.test(name) && (await this.ageOf(name)) > 60_000);
      if (stale) await unlink(path.join(this.dir, name)).catch(() => {});
    }
    const missing: Promise<unknown>[] = [];
    for (const source of this.allowed.values()) {
      if (!(await this.read(source))) missing.push(this.refresh(source));
    }
    await Promise.all(missing);
  }

  private async read(source: IconSource): Promise<{ icon: Icon; age: number } | undefined> {
    const file = path.join(this.dir, fileName(source));
    try {
      const [body, info] = await Promise.all([readFile(file), stat(file)]);
      const type = sniffImageType(body);
      return type ? { icon: { body, type }, age: Date.now() - info.mtimeMs } : undefined;
    } catch {
      return undefined;
    }
  }

  private async ageOf(name: string): Promise<number> {
    const info = await stat(path.join(this.dir, name)).catch(() => undefined);
    return info ? Date.now() - info.mtimeMs : 0;
  }

  /** One download per icon at a time, however many requests ask for it. */
  private refresh(source: IconSource): Promise<Icon | undefined> {
    let pending = this.pending.get(source.url);
    if (!pending) {
      pending = this.download(source).finally(() => this.pending.delete(source.url));
      this.pending.set(source.url, pending);
    }
    return pending;
  }

  private async download(source: IconSource): Promise<Icon | undefined> {
    const { url } = source;
    const failed = this.failedAt.get(url);
    if (failed !== undefined && Date.now() - failed < RETRY_MS) return undefined;

    let icon: Icon;
    try {
      icon = await this.slot(() => this.fetch(source));
      this.failedAt.delete(url);
    } catch (error) {
      this.failedAt.set(url, Date.now());
      this.log('warn', 'icon not fetched, the page will try it directly', { url, error: String(error) });
      return undefined;
    }
    this.log('info', 'icon cached', { url, from: icon.from, type: icon.type, bytes: icon.body.length });
    // The data may have dropped this icon while it was downloading.
    if (this.allows(url)) await this.write(source, icon.body);
    return icon;
  }

  /** Write-then-rename, so a reader never sees half a file. */
  private async write(source: IconSource, body: Buffer) {
    const file = path.join(this.dir, fileName(source));
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, body);
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      this.log('warn', 'icon not saved to the cache', { url: source.url, error: String(error) });
    }
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    while (this.active >= PARALLEL) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Bump when favicon.ts picks differently: cached favicons then don't match, get pruned and refetched. */
const FAVICON_VERSION = 2;

/**
 * A favicon is named by its site and how it was found, not by the URL the page
 * asks for: copies fetched another way (through icon.horse, before) or by an
 * older version of the lookup don't match and get pruned.
 */
function fileName(source: IconSource): string {
  const key = source.site ? `favicon:v${FAVICON_VERSION}:${source.site}` : source.url;
  return createHash('sha256').update(key).digest('hex');
}
