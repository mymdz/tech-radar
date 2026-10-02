import assert from 'node:assert/strict';
import { test } from 'node:test';
import { glyphMask, WORK, type Rect } from './mask.ts';

type Color = [number, number, number];
const WHITE: Color = [255, 255, 255];
const DARK: Color = [28, 30, 32];
const PURPLE: Color = [120, 60, 250];
const BLUE: Color = [100, 160, 250];
const GREEN: Color = [0, 150, 57];

/** A WORK×WORK RGBA raster painted shape by shape; the whole square counts as drawn. */
function canvas() {
  const px = new Uint8ClampedArray(WORK * WORK * 4);
  const paint = (inside: (x: number, y: number) => boolean, [r, g, b]: Color) => {
    for (let y = 0; y < WORK; y++) {
      for (let x = 0; x < WORK; x++) {
        if (inside(x + 0.5, y + 0.5)) px.set([r, g, b, 255], (y * WORK + x) * 4);
      }
    }
  };
  return { px, paint, drawn: { x: 0, y: 0, w: WORK, h: WORK } as Rect };
}

const roundedRect = (x0: number, y0: number, x1: number, y1: number, radius: number) => (x: number, y: number) => {
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
};
const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r;
const box = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

const at = (mask: Float32Array, x: number, y: number) => mask[y * WORK + x];

test('a white squircle plate with a colored mark: the plate goes, the mark stays (qwencloud)', () => {
  const { px, paint, drawn } = canvas();
  paint(roundedRect(0, 0, WORK, WORK, 50), WHITE);
  paint(disc(80, 80, 30), PURPLE);
  const mask = glyphMask(px, drawn, 'auto');
  assert.ok(at(mask, 80, 80) > 0.9, 'mark kept');
  assert.ok(at(mask, 80, 20) < 0.1, 'plate removed');
  assert.equal(at(mask, 2, 2), 0, 'corner transparent');
});

test('a dark tile inside a transparent margin with colored bars: the bars stay (muesli)', () => {
  const { px, paint, drawn } = canvas();
  paint(roundedRect(6, 6, WORK - 6, WORK - 6, 36), DARK);
  for (let i = 0; i < 8; i++) paint(box(30 + i * 13, 40, 36 + i * 13, 120), BLUE);
  const mask = glyphMask(px, drawn, 'auto');
  assert.ok(at(mask, 33, 80) > 0.9, 'bar kept');
  assert.ok(at(mask, 39, 80) < 0.1, 'gap between bars removed');
  assert.ok(at(mask, 80, 20) < 0.1, 'tile removed');
});

test('a colored shape with a white detail keeps its shape, the detail is cut out (Nginx)', () => {
  const { px, paint, drawn } = canvas();
  paint(disc(80, 80, 70), GREEN);
  paint(box(60, 50, 100, 110), WHITE);
  const mask = glyphMask(px, drawn, 'auto');
  assert.ok(at(mask, 80, 20) > 0.9, 'colored shape kept');
  assert.ok(at(mask, 80, 80) < 0.1, 'white detail knocked out');
});

test('a plain black mark is not mistaken for a plate', () => {
  const { px, paint, drawn } = canvas();
  paint(roundedRect(20, 20, 140, 140, 30), [0, 0, 0]);
  const mask = glyphMask(px, drawn, 'auto');
  assert.ok(at(mask, 80, 80) > 0.9);
  assert.ok(at(mask, 25, 80) > 0.9);
});

test('a black wordmark with a colored accent is not a plate: too sparse to be one', () => {
  const { px, paint, drawn } = canvas();
  for (let i = 0; i < 5; i++) paint(box(10 + i * 30, 50, 25 + i * 30, 110), [0, 0, 0]);
  paint(disc(140, 40, 8), [230, 40, 40]);
  const mask = glyphMask(px, drawn, 'auto');
  assert.ok(at(mask, 17, 80) > 0.9, 'letters kept');
});

test('an opaque full-bleed background is still removed as before', () => {
  const { px, paint, drawn } = canvas();
  paint(box(0, 0, WORK, WORK), WHITE);
  paint(disc(80, 80, 40), PURPLE);
  const mask = glyphMask(px, drawn, 'auto');
  assert.ok(at(mask, 80, 80) > 0.9);
  assert.ok(at(mask, 10, 10) < 0.1);
});

test('silhouette mode still removes the plate, it only skips the knock-out', () => {
  const { px, paint, drawn } = canvas();
  paint(roundedRect(0, 0, WORK, WORK, 50), WHITE);
  paint(disc(80, 80, 30), PURPLE);
  const mask = glyphMask(px, drawn, 'silhouette');
  assert.ok(at(mask, 80, 80) > 0.9);
  assert.ok(at(mask, 80, 20) < 0.1);
});
