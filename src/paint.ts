import type { RadarData } from './types.ts';

/**
 * Colors come from the data when given, otherwise from CSS so they follow the
 * light/dark theme:
 *   - each sector gets its own hue, evenly spaced in OKLCH so any number of
 *     sectors stays equally vivid (lightness/chroma are theme tokens); icons
 *     take their sector's hue at full strength in every ring;
 *   - rings are one ink that fades outward (legend and tooltip dots).
 */

const FIRST_HUE = 250; // the top sector starts at blue

export function sectorPaint(data: RadarData): Map<string, string> {
  const n = data.sectors.length;
  return new Map(
    data.sectors.map((sector, i) => {
      const hue = Math.round((FIRST_HUE + (i * 360) / n) % 360);
      return [sector.id, sector.color ?? `oklch(var(--sector-l) var(--sector-c) ${hue})`];
    }),
  );
}

export function ringPaint(data: RadarData): Map<string, string> {
  const n = data.rings.length;
  return new Map(
    data.rings.map((ring, i) => {
      const fade = n > 1 ? Math.round((i / (n - 1)) * 65) : 0;
      return [ring.id, ring.color ?? `color-mix(in oklab, var(--ink), var(--paper) ${fade}%)`];
    }),
  );
}
