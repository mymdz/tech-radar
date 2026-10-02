import type { Entry, EntryLink, IconMode, Movement, RadarData, Ring, Sector } from '../types.ts';

export class RadarDataError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'RadarDataError';
    this.problems = problems;
  }
}

const ICON_MODES: IconMode[] = ['auto', 'silhouette', 'knockout', 'monogram'];

/**
 * Colors end up inside style attributes, so anything beyond a plain color value
 * (`red;background:url(…)`) would be CSS injection. Allowed: #hex, a named
 * color, or rgb()/hsl()/oklch()/… with numeric arguments only.
 */
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([0-9.,%\s/+-]*(deg|turn|rad)?[0-9.,%\s/+-]*\))$/i;

function parseColor(value: unknown, where: string, problems: string[]): string | undefined {
  const color = str(value);
  if (color === undefined || COLOR.test(color)) return color;
  problems.push(`${where}: color "${color}" isn’t a plain CSS color (use e.g. #4fd1a1 or oklch(0.6 0.15 250)).`);
  return undefined;
}
const MOVEMENTS: Movement[] = ['new', 'up', 'down'];

type Raw = Record<string, unknown>;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/**
 * Turns the loosely typed document (YAML/JSON) into validated radar data.
 * Collects every problem instead of stopping at the first one, so a broken
 * file can be fixed in one pass.
 */
export function parseRadar(doc: unknown): RadarData {
  const problems: string[] = [];
  if (!isObject(doc)) throw new RadarDataError(['The document must be a mapping with rings, sectors and entries.']);

  const rings = parseList(doc.rings, 'rings', problems).map((raw, i): Ring | null => {
    const name = str(raw.name);
    if (!name) {
      problems.push(`rings[${i}]: name is missing.`);
      return null;
    }
    return {
      id: str(raw.id) ?? slugify(name),
      name,
      color: parseColor(raw.color, `rings[${i}]`, problems),
      description: str(raw.description),
    };
  }).filter((r): r is Ring => r !== null);

  const sectors = parseList(doc.sectors, 'sectors', problems).map((raw, i): Sector | null => {
    const name = str(raw.name);
    if (!name) {
      problems.push(`sectors[${i}]: name is missing.`);
      return null;
    }
    return { id: str(raw.id) ?? slugify(name), name, color: parseColor(raw.color, `sectors[${i}]`, problems), description: str(raw.description) };
  }).filter((s): s is Sector => s !== null);

  if (rings.length === 0) problems.push('rings needs at least one ring.');
  if (sectors.length < 2) problems.push('sectors needs at least two sectors.');
  reportDuplicates(rings, 'rings', problems);
  reportDuplicates(sectors, 'sectors', problems);

  const findRing = lookup(rings);
  const findSector = lookup(sectors);
  const seenIds = new Set<string>();

  const entries = parseList(doc.entries, 'entries', problems).map((raw, i): Entry | null => {
    const name = str(raw.name);
    const where = `entries[${i}]${name ? ` (${name})` : ''}`;
    if (!name) {
      problems.push(`${where}: name is missing.`);
      return null;
    }
    const ring = findRing(str(raw.ring));
    const sector = findSector(str(raw.sector));
    if (!ring) problems.push(`${where}: ring "${raw.ring ?? ''}" doesn’t exist. Available: ${rings.map((r) => r.id).join(', ')}.`);
    if (!sector) problems.push(`${where}: sector "${raw.sector ?? ''}" doesn’t exist. Available: ${sectors.map((s) => s.id).join(', ')}.`);
    if (!ring || !sector) return null;

    let id = str(raw.id) ?? slugify(name);
    if (seenIds.has(id)) id = `${id}-${i}`;
    seenIds.add(id);

    const iconMode = (str(raw.iconMode) ?? 'auto') as IconMode;
    if (!ICON_MODES.includes(iconMode)) problems.push(`${where}: iconMode must be one of ${ICON_MODES.join(', ')}.`);

    const moved = str(raw.moved) as Movement | undefined;
    if (moved && !MOVEMENTS.includes(moved)) problems.push(`${where}: moved must be one of ${MOVEMENTS.join(', ')}.`);

    return {
      id,
      name,
      sector: sector.id,
      ring: ring.id,
      icon: str(raw.icon),
      iconMode,
      description: str(raw.description),
      rationale: str(raw.rationale ?? raw.why),
      links: parseLinks(raw, where, problems),
      moved,
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
      added: dateText(raw.added),
      updated: dateText(raw.updated),
    };
  }).filter((e): e is Entry => e !== null);

  if (problems.length > 0) throw new RadarDataError(problems);

  return {
    title: str(doc.title) ?? 'Tech Radar',
    subtitle: str(doc.subtitle),
    updated: parseDate(doc.updated),
    startAngle: typeof doc.startAngle === 'number' ? doc.startAngle : undefined,
    rings,
    sectors,
    entries,
  };
}

function parseList(value: unknown, field: string, problems: string[]): Raw[] {
  if (!Array.isArray(value)) {
    problems.push(`${field} must be a list.`);
    return [];
  }
  return value.filter((item, i) => {
    if (isObject(item)) return true;
    problems.push(`${field}[${i}] must be a mapping.`);
    return false;
  });
}

function reportDuplicates(items: { id: string }[], field: string, problems: string[]) {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) problems.push(`${field}: id "${id}" is used twice.`);
    seen.add(id);
  }
}

/** Entries may reference a ring or sector by its id or by its display name. */
function lookup<T extends { id: string; name: string }>(items: T[]) {
  return (ref: string | undefined): T | undefined => {
    if (!ref) return undefined;
    const key = ref.toLowerCase();
    return items.find((item) => item.id.toLowerCase() === key || item.name.toLowerCase() === key);
  };
}

/**
 * `link` is the main link (docs, homepage); `links` are extras such as my own
 * notes in Outline. Either can be a bare URL or a {title, url} mapping. The main
 * link comes first and is marked primary; without one, the first extra is.
 */
function parseLinks(raw: Raw, where: string, problems: string[]): EntryLink[] {
  const toLink = (value: unknown): EntryLink | null => {
    if (typeof value === 'string' && value.trim()) return { title: linkTitle(value.trim()), url: value.trim() };
    if (isObject(value) && str(value.url)) return { title: str(value.title) ?? linkTitle(String(value.url)), url: String(value.url) };
    return null;
  };

  const links: EntryLink[] = [];
  if (raw.link !== undefined && raw.link !== null) {
    const main = toLink(raw.link);
    if (main) links.push(main);
    else problems.push(`${where}: link must be a URL or a {title, url} mapping.`);
  }
  if (raw.links !== undefined && raw.links !== null) {
    if (!Array.isArray(raw.links)) problems.push(`${where}: links must be a list.`);
    else
      raw.links.forEach((value, i) => {
        const extra = toLink(value);
        if (extra) links.push(extra);
        else problems.push(`${where}: links[${i}] must be a URL or a {title, url} mapping.`);
      });
  }
  if (links.length > 0) links[0].primary = true;
  return links;
}

function linkTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Entry dates are free text shown as written ("September 2026"). YAML turns a bare
 * 2026-09-29 into a Date, which would print as "Tue Sep 29 2026 03:00…", so
 * those go back to the ISO day.
 */
function dateText(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  return str(value);
}

function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  const text = str(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
