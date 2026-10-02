/** How a source image is turned into a radar glyph. */
export type IconMode = 'auto' | 'silhouette' | 'knockout' | 'monogram';

/** Movement since the previous edition of the radar. */
export type Movement = 'new' | 'up' | 'down';

export interface Ring {
  id: string;
  name: string;
  /** Optional override; by default rings are one ink fading outward (see paint.ts). */
  color?: string;
  description?: string;
}

export interface Sector {
  id: string;
  name: string;
  /** Optional override; by default each sector gets an evenly spaced hue (see paint.ts). */
  color?: string;
  description?: string;
}

export interface EntryLink {
  title: string;
  url: string;
  /** The main link (`link` in the data); the rest are extras from `links`. */
  primary?: boolean;
}

export interface Entry {
  id: string;
  name: string;
  sector: string;
  ring: string;
  /** Raw icon spec from the data: URL or `provider:slug` shorthand. */
  icon?: string;
  iconMode: IconMode;
  description?: string;
  rationale?: string;
  links: EntryLink[];
  moved?: Movement;
  tags: string[];
  /** When the entry appeared on the radar, as written by hand ("September 2026"). */
  added?: string;
  /** When the assessment was last revisited, same free form. */
  updated?: string;
}

export interface RadarData {
  title: string;
  subtitle?: string;
  updated?: Date;
  /** Rotation of the first sector boundary, degrees clockwise from 12 o'clock. */
  startAngle?: number;
  rings: Ring[];
  sectors: Sector[];
  entries: Entry[];
  /** Set when the source fell back to an older version, e.g. the Outline document is broken. */
  notice?: string;
}

/** Anything that can produce radar data: a YAML file today, an API tomorrow. */
export interface RadarSource {
  readonly label: string;
  load(): Promise<RadarData>;
}
