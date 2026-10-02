import type { IconMode } from '../types.ts';

/**
 * The pixel half of the glyph pipeline (glyph.ts draws, this decides): which
 * pixels of a rasterized logo belong to the mark. Pure, so tests can run it in
 * Node on synthetic or decoded images.
 */

export const WORK = 160; // working raster, px

/** Where the image was drawn inside the WORK×WORK raster. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Opacity of the mark per pixel of the WORK×WORK RGBA raster, 0…1. */
export function glyphMask(pixels: Uint8ClampedArray, drawn: Rect, mode: IconMode): Float32Array {
  const background = solidBackground(pixels, drawn) ?? neutralPlate(pixels, drawn);
  let mask = buildMask(pixels, background);
  // A full-bleed mark (the TypeScript tile: a square with "TS" cut through)
  // also has an opaque border, but "removing the background" erases it whole.
  if (background && coverage(mask) < 0.03 * ((drawn.w * drawn.h) / (WORK * WORK))) mask = buildMask(pixels, null);

  if (mode !== 'silhouette') knockOut(pixels, mask, mode === 'knockout');
  return mask;
}

function buildMask(px: Uint8ClampedArray, background: number[] | null): Float32Array {
  const mask = new Float32Array(WORK * WORK);
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    let a = px[p + 3] / 255;
    if (background) {
      const d = Math.hypot(px[p] - background[0], px[p + 1] - background[1], px[p + 2] - background[2]);
      a *= smoothstep(18, 70, d);
    }
    mask[i] = a;
  }
  return mask;
}

/** Share of the canvas covered by the glyph. */
function coverage(mask: Float32Array): number {
  let sum = 0;
  for (const a of mask) sum += a;
  return sum / mask.length;
}

/** If the image border is mostly opaque, it's a background plate — return its color. */
function solidBackground(px: Uint8ClampedArray, { x, y, w, h }: Rect): number[] | null {
  const samples: number[][] = [];
  const take = (cx: number, cy: number) => {
    const p = (cy * WORK + cx) * 4;
    if (px[p + 3] > 200) samples.push([px[p], px[p + 1], px[p + 2]]);
  };
  const x1 = x + w - 2;
  const y1 = y + h - 2;
  let total = 0;
  for (let cx = x + 1; cx <= x1; cx += 2) {
    take(cx, y + 1);
    take(cx, y1);
    total += 2;
  }
  for (let cy = y + 1; cy <= y1; cy += 2) {
    take(x + 1, cy);
    take(x1, cy);
    total += 2;
  }
  if (samples.length < total * 0.7) return null;
  return [0, 1, 2].map((c) => median(samples.map((s) => s[c])));
}

/**
 * App-icon style favicons put the mark on a rounded tile, a circle or a
 * squircle with transparent corners — often with a margin around it — so the
 * image border says nothing and solidBackground misses the plate. Here the
 * plate is read along the outline of the opaque shape instead.
 *
 * Only a solid, single-color, neutral plate (white, black, gray) counts: a
 * colored shape with a white detail is the mark itself (the Nginx hexagon)
 * and is left to knockOut.
 */
function neutralPlate(px: Uint8ClampedArray, { x, y, w, h }: Rect): number[] | null {
  const INSET = 2; // past the anti-aliased edge
  const opaque = (cx: number, cy: number) => px[(cy * WORK + cx) * 4 + 3] > 200;
  const samples: number[][] = [];
  const take = (cx: number, cy: number) => {
    if (cx < x || cx >= x + w || cy < y || cy >= y + h || !opaque(cx, cy)) return;
    const p = (cy * WORK + cx) * 4;
    samples.push([px[p], px[p + 1], px[p + 2]]);
  };

  let filled = 0;
  let minX = WORK, minY = WORK, maxX = -1, maxY = -1;
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      if (!opaque(cx, cy)) continue;
      filled++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
  }
  if (maxX < 0) return null;
  // A plate is a filled shape: a circle covers 79% of its box, a rounded tile more.
  if (filled < 0.7 * (maxX - minX + 1) * (maxY - minY + 1)) return null;

  // Walk in from all four sides to the first opaque pixel, then a little further.
  for (let cy = minY; cy <= maxY; cy += 2) {
    let left = minX;
    while (left <= maxX && !opaque(left, cy)) left++;
    let right = maxX;
    while (right >= left && !opaque(right, cy)) right--;
    if (left > right) continue;
    take(left + INSET, cy);
    take(right - INSET, cy);
  }
  for (let cx = minX; cx <= maxX; cx += 2) {
    let top = minY;
    while (top <= maxY && !opaque(cx, top)) top++;
    let bottom = maxY;
    while (bottom >= top && !opaque(cx, bottom)) bottom--;
    if (top > bottom) continue;
    take(cx, top + INSET);
    take(cx, bottom - INSET);
  }
  if (samples.length < 40) return null;

  const color = [0, 1, 2].map((c) => median(samples.map((s) => s[c])));
  const near = samples.filter((s) => Math.hypot(s[0] - color[0], s[1] - color[1], s[2] - color[2]) < 40).length;
  if (near < 0.85 * samples.length) return null;
  const chroma = Math.max(...color) - Math.min(...color);
  return chroma <= 40 ? color : null;
}

/**
 * Colored marks often carry their meaning in white or black details (a letter
 * inside a hexagon, a wheel inside a heptagon). A plain alpha silhouette would
 * fill those in, so we split the opaque pixels by luminance (Otsu) and punch the
 * minority group out when it is clearly white-ish or black-ish.
 */
function knockOut(px: Uint8ClampedArray, mask: Float32Array, force: boolean) {
  const lum = new Float32Array(mask.length);
  const histogram = new Array<number>(256).fill(0);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    lum[i] = 0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2];
    if (mask[i] > 0.5) {
      histogram[Math.round(lum[i])]++;
      count++;
    }
  }
  if (count < 50) return;

  const { threshold, darkShare, darkMean, lightMean } = otsu(histogram, count);
  const minorityIsLight = darkShare >= 0.5;
  const minorityShare = minorityIsLight ? 1 - darkShare : darkShare;
  const minorityMean = minorityIsLight ? lightMean : darkMean;
  const separated = lightMean - darkMean > (force ? 30 : 70);
  const neutralDetail = minorityIsLight ? minorityMean > 205 : minorityMean < 45;
  if (!separated || minorityShare < 0.04 || minorityShare > 0.48) return;
  if (!force && !neutralDetail) return;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) continue;
    const towardMinority = minorityIsLight ? lum[i] - threshold : threshold - lum[i];
    if (towardMinority > 0) mask[i] *= 1 - smoothstep(0, 28, towardMinority);
  }
}

function otsu(histogram: number[], total: number) {
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * histogram[i];
  let sumDark = 0;
  let weightDark = 0;
  let best = { threshold: 128, variance: -1, darkShare: 0.5, darkMean: 0, lightMean: 255 };
  for (let t = 0; t < 256; t++) {
    weightDark += histogram[t];
    if (weightDark === 0) continue;
    const weightLight = total - weightDark;
    if (weightLight === 0) break;
    sumDark += t * histogram[t];
    const darkMean = sumDark / weightDark;
    const lightMean = (sumAll - sumDark) / weightLight;
    const variance = weightDark * weightLight * (darkMean - lightMean) ** 2;
    if (variance > best.variance) best = { threshold: t + 0.5, variance, darkShare: weightDark / total, darkMean, lightMean };
  }
  return best;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
