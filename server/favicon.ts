import { fetchIcon, fetchLimited, type FetchIconOptions, type Icon } from './icon-fetch.ts';

/**
 * Finds a site's favicon on the site itself, the way a browser does: the
 * <link rel="icon"> tags of its home page, then /favicon.ico. Every request
 * goes through the guarded fetcher (public addresses only, size-capped).
 *
 * What makes a good glyph is not what makes a good tab icon. In order:
 *   1. an SVG icon — vector, usually on a transparent background;
 *   2. Safari's mask-icon — a one-color silhouette, a glyph already;
 *   3. other icons, bigger first (PNG, ICO);
 *   4. /favicon.ico;
 *   5. an apple-touch-icon — an opaque tile, but often the only big picture:
 *      sites like meetily.ai list 16 and 32 px icons and put the 256 px one
 *      here. A 32 px raster has no details left to make a glyph from.
 * Resolution decides, judged by the downloaded image, not the declared sizes:
 * the first one at least GOOD_PX wide is taken, else the biggest of the tries.
 */

const MAX_HTML_BYTES = 256 * 1024; // the <head> is at the start; the rest is cut off
const MAX_ICONS = 3; // best candidates tried, plus /favicon.ico and one touch icon
const GOOD_PX = 96;
const DEADLINE_MS = 20_000;

export interface IconCandidate {
  url: string;
  kind: 'svg' | 'mask' | 'raster' | 'fallback' | 'touch';
  /** Declared in `sizes`; 0 when not given. */
  size: number;
}

export async function fetchFavicon(pageUrl: string, options: FetchIconOptions = {}): Promise<Icon> {
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const opts = { ...options, signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline };

  let html = '';
  let base = new URL(pageUrl);
  const problems: string[] = [];
  try {
    const page = await fetchLimited(pageUrl, { ...opts, accept: 'text/html,application/xhtml+xml', maxBytes: MAX_HTML_BYTES, truncate: true });
    html = page.body.toString('utf8');
    base = page.url; // links are relative to where redirects ended (www., https)
  } catch (error) {
    // A page behind a bot wall may still serve /favicon.ico.
    problems.push(`${pageUrl}: ${(error as Error).message}`);
  }

  let best: { icon: Icon; px: number } | undefined;
  for (const url of pickTries(rankIcons(html, base))) {
    let icon: Icon;
    try {
      icon = { ...(await fetchIcon(url, opts)), from: url };
    } catch (error) {
      problems.push(`${url}: ${(error as Error).message}`);
      continue;
    }
    // Formats we don't measure (JPEG, WebP, AVIF) are taken as they are.
    const px = pixelSize(icon) ?? Number.POSITIVE_INFINITY;
    if (px >= GOOD_PX) return icon;
    if (!best || px > best.px) best = { icon, px };
  }
  if (best) return best.icon;
  throw new Error(`no usable favicon (${problems.join('; ')})`);
}

/** Every icon the page declares plus /favicon.ico, best for a glyph first. */
export function rankIcons(html: string, base: URL): IconCandidate[] {
  const head = html.split(/<\/head\s*>/i)[0];
  const found: (IconCandidate & { score: number })[] = [{ url: new URL('/favicon.ico', base).href, kind: 'fallback', size: 0, score: 100 }];

  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (!attrs.href) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(attrs.href), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;

    const svg = /svg/i.test(attrs.type ?? '') || /\.svg$/i.test(url.pathname);
    const size = largestSize(attrs.sizes);
    const candidate = { url: url.href, size };
    if (rel.includes('icon')) {
      found.push(svg ? { ...candidate, kind: 'svg', score: 400 } : { ...candidate, kind: 'raster', score: 200 + Math.min(size, 256) / 4 });
    } else if (rel.includes('mask-icon')) {
      found.push({ ...candidate, kind: 'mask', score: 300 });
    } else if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) {
      found.push({ ...candidate, kind: 'touch', score: 50 });
    }
  }

  // Stable: equal scores keep document order. A URL counts once, at its best.
  const seen = new Set<string>();
  return found
    .sort((a, b) => b.score - a.score)
    .filter((c) => !seen.has(c.url) && seen.add(c.url))
    .map(({ url, kind, size }) => ({ url, kind, size }));
}

/**
 * The few worth downloading: the top icons, /favicon.ico, and the touch icon
 * nearest a useful size — big enough, but not a 1024 px file over the byte cap.
 */
export function pickTries(ranked: IconCandidate[]): string[] {
  const icons = ranked.filter((c) => c.kind !== 'fallback' && c.kind !== 'touch').slice(0, MAX_ICONS);
  const fallback = ranked.filter((c) => c.kind === 'fallback');
  const touches = ranked.filter((c) => c.kind === 'touch');
  const usable = touches.filter((c) => c.size === 0 || (c.size >= GOOD_PX && c.size <= 512));
  const touch = (usable.length ? usable : touches).sort((a, b) => b.size - a.size).slice(0, 1);
  return [...icons, ...fallback, ...touch].map((c) => c.url);
}

/** Pixel width of the biggest image inside, for the formats favicons come in; Infinity for SVG. */
export function pixelSize({ body, type }: Icon): number | undefined {
  switch (type) {
    case 'image/svg+xml':
      return Number.POSITIVE_INFINITY;
    case 'image/png':
      return body.length >= 24 ? Math.max(body.readUInt32BE(16), body.readUInt32BE(20)) : undefined;
    case 'image/gif':
      return body.length >= 10 ? Math.max(body.readUInt16LE(6), body.readUInt16LE(8)) : undefined;
    case 'image/x-icon': {
      // ICONDIR, then 16-byte entries; a width or height byte of 0 means 256.
      const count = body.length >= 6 ? body.readUInt16LE(4) : 0;
      let px = 0;
      for (let i = 0; i < count && 6 + i * 16 + 2 <= body.length; i++) {
        const entry = 6 + i * 16;
        px = Math.max(px, body[entry] || 256, body[entry + 1] || 256);
      }
      return px || undefined;
    }
    default:
      return undefined;
  }
}

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/** "16x16 32x32" → 32; "any" (scalable) → 256; nothing → 0. */
function largestSize(sizes: string | undefined): number {
  if (!sizes) return 0;
  if (/\bany\b/i.test(sizes)) return 256;
  return Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/gi)].map((m) => Math.max(Number(m[1]), Number(m[2]))));
}
