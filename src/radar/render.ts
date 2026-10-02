import { sectorPaint } from '../paint.ts';
import type { Entry, RadarData } from '../types.ts';
import { polar, RADIUS, VIEW_SIZE, type Layout } from './layout.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const SWEEP_MS = 500;

type Attrs = Record<string, string | number>;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Node[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

export interface BlipHandlers {
  onEnter(entry: Entry, target: SVGGElement): void;
  onLeave(entry: Entry): void;
  onActivate(entry: Entry, target: SVGGElement): void;
  onSectorHover(sectorId: string | null): void;
}

export interface RadarView {
  svg: SVGSVGElement;
  blip(id: string): SVGGElement | undefined;
  applyGlyph(entryIds: string[], dataUrl: string): void;
  setHidden(ids: Set<string>): void;
  setSpotlight(ids: Set<string> | null): void;
  setSelected(id: string | null): void;
  setActiveSector(id: string | null): void;
}

export function renderRadar(data: RadarData, layout: Layout, handlers: BlipHandlers): RadarView {
  const half = VIEW_SIZE / 2;
  const svg = el('svg', {
    viewBox: `${-half} ${-half} ${VIEW_SIZE} ${VIEW_SIZE}`,
    class: 'radar',
    role: 'img',
    'aria-label': `${data.title}: ${data.entries.length} technologies in ${data.sectors.length} sectors`,
  });
  const defs = el('defs');
  svg.append(defs);

  const sectorColor = sectorPaint(data);

  // Ring bands: a faint ink wash that deepens toward the center, where the
  // technologies I rely on live.
  const bands = el('g', { class: 'bands' });
  layout.rings.forEach((band, i) => {
    const depth = 1 - i / layout.rings.length;
    bands.append(el('path', { d: annulus(band.inner, band.outer), class: 'band', 'fill-opacity': (0.008 + 0.03 * depth).toFixed(3), 'fill-rule': 'evenodd' }));
  });

  // Each sector carries a faint wash of its hue, stronger under the pointer.
  const wedges = el('g', { class: 'wedges' });
  const wedgeById = new Map<string, SVGPathElement>();
  for (const arc of layout.sectors) {
    const wedge = el('path', { d: wedgePath(RADIUS, arc.start, arc.end), class: 'wedge', style: `--sc:${sectorColor.get(arc.id)}` });
    wedgeById.set(arc.id, wedge);
    wedges.append(wedge);
  }

  // Sector under the pointer is found geometrically rather than with enter/leave
  // on the wedges: blips sit on top of the wedges and would make it flicker.
  let hoveredSector: string | null = null;
  const trackSector = (event: PointerEvent) => {
    const ctm = svg.getScreenCTM();
    let next: string | null = null;
    if (ctm && event.type !== 'pointerleave') {
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
      if (Math.hypot(p.x, p.y) <= RADIUS + 60) {
        const angle = (Math.atan2(p.x, -p.y) * 180) / Math.PI;
        next = layout.sectors.find((arc) => inArc(angle, arc.start, arc.end))?.id ?? null;
      }
    }
    if (next !== hoveredSector) {
      hoveredSector = next;
      handlers.onSectorHover(next);
    }
  };
  svg.addEventListener('pointermove', trackSector);
  svg.addEventListener('pointerleave', trackSector);

  const grid = el('g', { class: 'grid' });
  for (const band of layout.rings) grid.append(el('circle', { r: band.outer, class: 'ring-line' }));
  for (const arc of layout.sectors) {
    const edge = polar(RADIUS, arc.start);
    grid.append(el('line', { x1: 0, y1: 0, x2: edge.x, y2: edge.y, class: 'spoke' }));
  }
  grid.append(ticks());

  const sectorLabels = el('g', { class: 'sector-labels' });
  const labelById = new Map<string, SVGTextElement>();
  data.sectors.forEach((sector, i) => {
    const arc = layout.sectors[i];
    const pathId = `sector-path-${i}`;
    defs.append(el('path', { id: pathId, d: labelArc(arc.start, arc.end) }));
    const textPath = el('textPath', { href: `#${pathId}`, startOffset: '50%' });
    textPath.textContent = sector.name;
    const text = el('text', { class: 'sector-label', 'text-anchor': 'middle' }, textPath);
    labelById.set(sector.id, text);
    sectorLabels.append(text);
  });

  const ringLabels = el('g', { class: 'ring-labels' });
  layout.ringLabels.forEach((label, i) => {
    const text = el('text', { x: 0, y: label.y + 14, class: 'ring-label', 'text-anchor': 'middle' });
    text.textContent = data.rings[i].name;
    ringLabels.append(text);
  });

  const blipLayer = el('g', { class: 'blips' });
  const blipById = new Map<string, SVGGElement>();
  const r = layout.blipRadius;
  for (const entry of data.entries) {
    const point = layout.blips.get(entry.id)!;
    const blip = renderBlip(entry, r, sectorColor.get(entry.sector)!, point.x, point.y);
    const ring = data.rings.find((x) => x.id === entry.ring)!;
    const sector = data.sectors.find((x) => x.id === entry.sector)!;
    blip.setAttribute('aria-label', `${entry.name}: ${ring.name}, ${sector.name}`);
    // Hover preview is for mouse and keyboard only. A finger fires pointerenter
    // on touch-down and pointerleave on lift: iOS Safari saw the tooltip appear on
    // "hover", swallowed the click that would have pinned it, and the lift then
    // hid it again. Touch goes straight through click → pinned tooltip.
    blip.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') handlers.onEnter(entry, blip);
    });
    blip.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'touch') handlers.onLeave(entry);
    });
    blip.addEventListener('focus', () => {
      if (blip.matches(':focus-visible')) handlers.onEnter(entry, blip);
    });
    blip.addEventListener('blur', () => handlers.onLeave(entry));
    blip.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onActivate(entry, blip);
    });
    blip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handlers.onActivate(entry, blip);
      }
    });
    blipById.set(entry.id, blip);
    blipLayer.append(blip);
  }

  svg.append(bands, wedges, grid, sectorLabels, ringLabels, blipLayer);

  const glyphMasks = new Map<string, string>();
  const glyphSize = r * 1.22;

  return {
    svg,
    blip: (id) => blipById.get(id),
    applyGlyph(entryIds, dataUrl) {
      let maskId = glyphMasks.get(dataUrl);
      if (!maskId) {
        maskId = `glyph-${glyphMasks.size}`;
        glyphMasks.set(dataUrl, maskId);
        const box = { x: -glyphSize / 2, y: -glyphSize / 2, width: glyphSize, height: glyphSize };
        defs.append(el('mask', { id: maskId, maskUnits: 'userSpaceOnUse', ...box }, el('image', { href: dataUrl, ...box })));
      }
      for (const id of entryIds) {
        const body = blipById.get(id)?.querySelector('.blip-body');
        if (!body) continue;
        body.querySelector('.blip-mark')?.remove();
        body.append(el('rect', { class: 'blip-mark blip-glyph', x: -glyphSize / 2, y: -glyphSize / 2, width: glyphSize, height: glyphSize, mask: `url(#${maskId})` }));
      }
    },
    setHidden(ids) {
      blipById.forEach((blip, id) => blip.classList.toggle('is-hidden', ids.has(id)));
    },
    setSpotlight(ids) {
      svg.classList.toggle('has-spotlight', ids !== null);
      blipById.forEach((blip, id) => blip.classList.toggle('is-lit', ids?.has(id) ?? false));
    },
    setSelected(id) {
      blipById.forEach((blip, blipId) => blip.classList.toggle('is-selected', blipId === id));
    },
    setActiveSector(id) {
      wedgeById.forEach((wedge, key) => wedge.classList.toggle('is-active', key === id));
      labelById.forEach((label, key) => label.classList.toggle('is-active', key === id));
    },
  };
}

function renderBlip(entry: Entry, r: number, color: string, x: number, y: number): SVGGElement {
  const angle = (((Math.atan2(x, -y) * 180) / Math.PI) + 360) % 360;
  const blip = el('g', {
    class: 'blip',
    transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`,
    tabindex: 0,
    role: 'button',
    'data-id': entry.id,
    style: `--c:${color};--reveal-delay:${Math.round((angle / 360) * SWEEP_MS)}ms`,
  });
  const body = el('g', { class: 'blip-body' });
  body.append(el('circle', { r, class: 'blip-bg' }));

  const monogram = el('text', { class: 'blip-mark blip-monogram', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': (r * 0.78).toFixed(1) });
  monogram.textContent = initials(entry.name);
  body.append(monogram);

  if (entry.moved === 'new') {
    body.append(el('circle', { r: r + 3.5, class: 'blip-halo' }));
  } else if (entry.moved) {
    // A small arrowhead on the side the entry moved toward: center for "up", rim for "down".
    const toCenter = entry.moved === 'up';
    const rotation = toCenter ? angle + 180 : angle;
    const s = 3.6;
    const tip = r + 1 + s * 1.6;
    const arrow = el('path', { d: `M 0 ${-tip} L ${s} ${-tip + s * 1.6} L ${-s} ${-tip + s * 1.6} Z`, class: 'blip-arrow', transform: `rotate(${rotation.toFixed(1)})` });
    body.append(arrow);
  }

  blip.append(body);
  return blip;
}

export function initials(name: string): string {
  const words = name.split(/[\s\-_.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? '?';
  return word[0].toUpperCase() + (word[1] ?? '').toLowerCase();
}

function inArc(angle: number, start: number, end: number): boolean {
  const offset = (((angle - start) % 360) + 360) % 360;
  return offset < end - start;
}

function annulus(inner: number, outer: number): string {
  const circle = (r: number) => `M 0 ${-r} A ${r} ${r} 0 1 1 0 ${r} A ${r} ${r} 0 1 1 0 ${-r} Z`;
  return inner > 0 ? `${circle(outer)} ${circle(inner)}` : circle(outer);
}

function wedgePath(r: number, start: number, end: number): string {
  const a = polar(r, start);
  const b = polar(r, end);
  return `M 0 0 L ${a.x} ${a.y} A ${r} ${r} 0 ${end - start > 180 ? 1 : 0} 1 ${b.x} ${b.y} Z`;
}

/** Labels on the lower half run counter-clockwise so they never read upside down. */
function labelArc(start: number, end: number): string {
  const mid = (((start + end) / 2) % 360 + 360) % 360;
  const bottom = mid > 90 && mid < 270;
  const r = RADIUS + (bottom ? 42 : 28);
  const a = polar(r, start);
  const b = polar(r, end);
  const large = end - start > 180 ? 1 : 0;
  return bottom ? `M ${b.x} ${b.y} A ${r} ${r} 0 ${large} 0 ${a.x} ${a.y}` : `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

/** Instrument-style tick marks around the rim. */
function ticks(): SVGGElement {
  const group = el('g', { class: 'ticks' });
  const parts: string[] = [];
  for (let deg = 0; deg < 360; deg += 2) {
    const major = deg % 30 === 0;
    const a = polar(RADIUS + 5, deg);
    const b = polar(RADIUS + (major ? 14 : 9), deg);
    parts.push(`M ${a.x.toFixed(2)} ${a.y.toFixed(2)} L ${b.x.toFixed(2)} ${b.y.toFixed(2)}`);
  }
  group.append(el('path', { d: parts.join(' '), class: 'tick' }));
  return group;
}
