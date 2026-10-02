import type { Entry, RadarData } from '../types.ts';

/**
 * Pure geometry: where rings, sectors, labels and blips go.
 * Coordinates live in an SVG viewBox centered at (0, 0); angles are degrees
 * clockwise from 12 o'clock, the same convention CSS conic-gradient uses.
 */

export const VIEW_SIZE = 1000;
export const RADIUS = 408;

export interface Point {
  x: number;
  y: number;
}

export interface RingBand {
  id: string;
  inner: number;
  outer: number;
}

export interface SectorArc {
  id: string;
  start: number;
  end: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RingLabel extends Box {
  ringId: string;
}

export interface Layout {
  radius: number;
  rings: RingBand[];
  sectors: SectorArc[];
  ringLabels: RingLabel[];
  blipRadius: number;
  blips: Map<string, Point>;
}

const GAP = 5; // minimum air between two blips
const LABEL_HEIGHT = 20;

export function polar(radius: number, angle: number): Point {
  const rad = (angle * Math.PI) / 180;
  return { x: radius * Math.sin(rad), y: -radius * Math.cos(rad) };
}

export function computeLayout(data: RadarData): Layout {
  const rings = ringBands(data);
  const sectors = sectorArcs(data);
  const ringLabels = rings.map((band, i): RingLabel => {
    const width = data.rings[i].name.length * 7.6 + 16;
    return { ringId: band.id, x: -width / 2, y: -band.outer + 5, width, height: LABEL_HEIGHT };
  });

  const cells = groupIntoCells(data.entries);
  const blipRadius = fitBlipRadius(cells, rings, sectors);
  const blips = new Map<string, Point>();

  for (const [key, entries] of cells) {
    const [sectorId, ringId] = key.split('\u0000');
    const band = rings.find((r) => r.id === ringId)!;
    const arc = sectors.find((s) => s.id === sectorId)!;
    placeCell(entries, band, arc, blipRadius, ringLabels).forEach((point, id) => blips.set(id, point));
  }

  return { radius: RADIUS, rings, sectors, ringLabels, blipRadius, blips };
}

/**
 * Ring widths sit halfway between "equal width" and "equal area": inner rings
 * get a bit more room than a plain split, outer rings don't turn into slivers.
 */
function ringBands(data: RadarData): RingBand[] {
  const n = data.rings.length;
  let inner = 0;
  return data.rings.map((ring, i) => {
    const t = (i + 1) / n;
    const outer = RADIUS * ((t + Math.sqrt(t)) / 2);
    const band = { id: ring.id, inner, outer };
    inner = outer;
    return band;
  });
}

/** By default the first sector is centered at 12 o'clock. */
function sectorArcs(data: RadarData): SectorArc[] {
  const step = 360 / data.sectors.length;
  const start = data.startAngle ?? -step / 2;
  return data.sectors.map((sector, i) => ({ id: sector.id, start: start + i * step, end: start + (i + 1) * step }));
}

function groupIntoCells(entries: Entry[]): Map<string, Entry[]> {
  const cells = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = `${entry.sector}\u0000${entry.ring}`;
    const list = cells.get(key) ?? [];
    list.push(entry);
    cells.set(key, list);
  }
  return cells;
}

/** One blip size for the whole radar, as large as the most crowded cell allows. */
function fitBlipRadius(cells: Map<string, Entry[]>, rings: RingBand[], sectors: SectorArc[]): number {
  let radius = 15;
  const sweep = ((sectors[0].end - sectors[0].start) * Math.PI) / 180;
  for (const [key, entries] of cells) {
    const band = rings.find((r) => r.id === key.split('\u0000')[1])!;
    radius = Math.min(radius, (band.outer - band.inner) / 2 - 4);
    const area = (sweep / 2) * (band.outer ** 2 - band.inner ** 2);
    const side = Math.sqrt(area / (entries.length * 2.1));
    radius = Math.min(radius, (side - GAP) / 2);
  }
  return Math.max(7, radius);
}

/**
 * Deterministic placement: seeded random start (area-uniform inside the cell),
 * then a few rounds of relaxation that push blips apart and away from the ring
 * labels, clamped to the cell. Same data → same picture on every load.
 */
function placeCell(entries: Entry[], band: RingBand, arc: SectorArc, r: number, labels: Box[]): Map<string, Point> {
  const pad = r + 5;
  const halfSweep = ((arc.end - arc.start) / 2) * (Math.PI / 180);
  const rMin = Math.max(band.inner + pad, pad / Math.sin(Math.min(halfSweep, Math.PI / 2)) + 2);
  const rMax = Math.max(rMin, band.outer - pad);

  const points = [...entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => {
      const random = mulberry32(hash(entry.id));
      const rho = Math.sqrt(rMin ** 2 + random() * (rMax ** 2 - rMin ** 2));
      const angle = arc.start + (0.15 + random() * 0.7) * (arc.end - arc.start);
      return { id: entry.id, ...polar(rho, angle) };
    });

  const spacing = 2 * r + GAP;
  const reach = spacing * 1.35; // push a little beyond touching, for an even spread
  for (let iter = 0; iter < 160; iter++) {
    const strength = 0.5 * (1 - iter / 200);
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= reach) continue;
        if (d < 0.01) {
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d = 1;
        }
        const push = ((reach - d) / 2) * strength * (d < spacing ? 1 : 0.35);
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }
    for (const p of points) {
      for (const box of labels) avoidBox(p, box, r + 3);
      clampToCell(p, rMin, rMax, arc, pad);
    }
  }

  return new Map(points.map((p) => [p.id, { x: p.x, y: p.y }]));
}

function avoidBox(p: Point, box: Box, clearance: number) {
  const nx = Math.max(box.x, Math.min(p.x, box.x + box.width));
  const ny = Math.max(box.y, Math.min(p.y, box.y + box.height));
  const dx = p.x - nx;
  const dy = p.y - ny;
  const d = Math.hypot(dx, dy);
  if (d >= clearance) return;
  if (d > 0.01) {
    p.x = nx + (dx / d) * clearance;
    p.y = ny + (dy / d) * clearance;
  } else {
    // Center is inside the label: leave through the nearest vertical edge.
    const toTop = p.y - box.y;
    const toBottom = box.y + box.height - p.y;
    p.y = toTop < toBottom ? box.y - clearance : box.y + box.height + clearance;
  }
}

function clampToCell(p: Point, rMin: number, rMax: number, arc: SectorArc, pad: number) {
  let rho = Math.hypot(p.x, p.y);
  let angle = (Math.atan2(p.x, -p.y) * 180) / Math.PI;
  const mid = (arc.start + arc.end) / 2;
  while (angle < mid - 180) angle += 360;
  while (angle > mid + 180) angle -= 360;

  rho = Math.min(rMax, Math.max(rMin, rho));
  const angularPad = (Math.asin(Math.min(1, pad / rho)) * 180) / Math.PI;
  const lo = arc.start + angularPad;
  const hi = arc.end - angularPad;
  angle = lo > hi ? mid : Math.min(hi, Math.max(lo, angle));

  const q = polar(rho, angle);
  p.x = q.x;
  p.y = q.y;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
