import type { IconMode } from '../types.ts';
import { glyphMask, WORK } from './mask.ts';

/**
 * Turns an arbitrary logo (SVG, PNG, favicon — any colors, any background)
 * into a white-on-transparent glyph, so every blip on the radar can be tinted
 * in its ring color and all icons read as one family.
 *
 * Pipeline: fetch → rasterize → strip a solid background if there is one
 * (a full-bleed one, or a neutral app-icon tile with transparent corners) →
 * optionally knock out the white/black details inside a colored mark
 * (so the white "N" in the Nginx hexagon stays visible) → crop to content →
 * fit into a square with optical size correction. The pixel decisions are in
 * mask.ts; this file fetches, draws and packs the result.
 */

const OUT = 96; // output glyph, px
const CACHE_PREFIX = 'glyph:v5:'; // bump when the pipeline or where images come from changes

const memory = new Map<string, Promise<string | null>>();

/** Resolves to a PNG data URL of the glyph, or null if the image can't be used. */
export function loadGlyph(url: string, mode: IconMode): Promise<string | null> {
  if (mode === 'monogram') return Promise.resolve(null);
  const key = `${CACHE_PREFIX}${mode}:${url}`;
  let pending = memory.get(key);
  if (!pending) {
    pending = fromStorage(key).then(async (cached) => {
      if (cached) return cached;
      try {
        const glyph = rasterToGlyph(await fetchIcon(url), mode);
        toStorage(key, glyph);
        return glyph;
      } catch (error) {
        console.warn(`[radar] icon ${url} skipped:`, (error as Error).message);
        return null;
      }
    });
    memory.set(key, pending);
  }
  return pending;
}

async function fromStorage(key: string): Promise<string | null> {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function toStorage(key: string, value: string | null) {
  if (!value) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage full or unavailable — the glyph just gets rebuilt next time.
  }
}

/**
 * Our server keeps a copy of every icon the radar uses (server/icons.ts); the
 * icon's own URL is the fallback — for icons it couldn't get, and for no server
 * at all, as under `vite dev`.
 */
async function fetchIcon(url: string): Promise<HTMLImageElement> {
  if (/^https?:\/\//i.test(url)) {
    try {
      return await fetchImage(`${import.meta.env.BASE_URL}icon?url=${encodeURIComponent(url)}`);
    } catch {
      // Fall through to the source.
    }
  }
  return fetchImage(url);
}

/**
 * Fetching (instead of <img crossorigin>) gives us a same-origin blob, so the
 * canvas never gets tainted, and lets us patch SVGs that lack an explicit size —
 * Firefox refuses to draw those onto a canvas.
 */
async function fetchImage(url: string): Promise<HTMLImageElement> {
  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let blob = await response.blob();
  const isSvg = blob.type.includes('svg') || /\.svg($|\?)/i.test(url);
  if (isSvg) blob = new Blob([sizeSvg(await blob.text())], { type: 'image/svg+xml' });

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function sizeSvg(source: string): string {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName !== 'svg') throw new Error('not an SVG document');
  const viewBox = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  let w = viewBox?.[2] ?? parseFloat(svg.getAttribute('width') ?? '');
  let h = viewBox?.[3] ?? parseFloat(svg.getAttribute('height') ?? '');
  if (!(w > 0 && h > 0)) w = h = 24;
  if (!viewBox) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const scale = 512 / Math.max(w, h);
  svg.setAttribute('width', String(Math.round(w * scale)));
  svg.setAttribute('height', String(Math.round(h * scale)));
  return new XMLSerializer().serializeToString(svg);
}

function rasterToGlyph(img: HTMLImageElement, mode: IconMode): string | null {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) throw new Error('image has no size');

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = WORK;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const scale = Math.min(WORK / iw, WORK / ih);
  const dw = Math.round(iw * scale);
  const dh = Math.round(ih * scale);
  const dx = Math.floor((WORK - dw) / 2);
  const dy = Math.floor((WORK - dh) / 2);
  ctx.drawImage(img, dx, dy, dw, dh);

  const pixels = ctx.getImageData(0, 0, WORK, WORK).data;
  return fitToSquare(glyphMask(pixels, { x: dx, y: dy, w: dw, h: dh }, mode));
}

function fitToSquare(mask: Float32Array): string | null {
  let minX = WORK, minY = WORK, maxX = -1, maxY = -1;
  for (let y = 0; y < WORK; y++) {
    for (let x = 0; x < WORK; x++) {
      if (mask[y * WORK + x] > 0.1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const source = document.createElement('canvas');
  source.width = source.height = WORK;
  const sctx = source.getContext('2d')!;
  const image = sctx.createImageData(WORK, WORK);
  for (let i = 0; i < mask.length; i++) {
    image.data.set([255, 255, 255, Math.round(mask[i] * 255)], i * 4);
  }
  sctx.putImageData(image, 0, 0);

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  // Compact (square-ish) marks look heavier than wide wordmarks at the same box
  // size, so shrink them a little for an even optical size across the radar.
  const squareness = Math.min(bw, bh) / Math.max(bw, bh);
  const scale = (OUT / Math.max(bw, bh)) * (1 - 0.14 * squareness);
  const w = bw * scale;
  const h = bh * scale;

  const out = document.createElement('canvas');
  out.width = out.height = OUT;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(source, minX, minY, bw, bh, (OUT - w) / 2, (OUT - h) / 2, w, h);
  return out.toDataURL('image/png');
}
