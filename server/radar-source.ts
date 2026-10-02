import yaml from 'js-yaml';
import { parseRadar, RadarDataError } from '../src/data/parse.ts';
import { extractYaml, type FetchedDocument } from './outline.ts';
import type { Log } from './log.ts';

export interface RadarSnapshot {
  /** Last version that passed validation; undefined until the first success. */
  body?: string;
  /** When the document behind `body` was edited, if Outline told us. */
  updatedAt?: string;
  /** Why the current document was rejected, if it was. */
  warning?: string;
}

/**
 * Serves the radar block from the Outline document.
 *
 * Outline is asked at most once per TTL, and concurrent requests share one
 * fetch. The block goes through the same parseRadar the page uses, so anything
 * that would break the page — bad YAML, an unknown ring — is rejected here: the
 * last good version keeps being served and the reason travels as a warning.
 */
export class RadarSource {
  private readonly fetchDocument: () => Promise<FetchedDocument>;
  private readonly ttlMs: number;
  private readonly log: Log;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | undefined;
  private good: string | undefined;
  private goodUpdatedAt: string | undefined;
  private warning: string | undefined;

  constructor(fetchDocument: () => Promise<FetchedDocument>, ttlMs: number, log: Log) {
    this.fetchDocument = fetchDocument;
    this.ttlMs = ttlMs;
    this.log = log;
  }

  async current(): Promise<RadarSnapshot> {
    if (!this.pending && Date.now() - this.checkedAt >= this.ttlMs) {
      this.pending = this.refresh().finally(() => {
        this.pending = undefined;
      });
    }
    // A request that arrives mid-fetch waits for it rather than seeing a
    // half-updated state (e.g. nothing at all on the very first load).
    if (this.pending) await this.pending;
    return { body: this.good, updatedAt: this.goodUpdatedAt, warning: this.warning };
  }

  private async refresh() {
    this.checkedAt = Date.now();
    try {
      const doc = await this.fetchDocument();
      const block = extractYaml(doc.text);
      validate(block);
      this.good = block;
      // The date belongs to the version being served: a rejected edit keeps the old one.
      this.goodUpdatedAt = doc.updatedAt;
      this.warning = undefined;
    } catch (error) {
      const reason = describe(error);
      if (reason !== this.warning) {
        this.log('warn', 'radar document rejected', { reason, hasFallback: this.good !== undefined });
      }
      this.warning = reason;
    }
  }
}

function validate(block: string) {
  let doc: unknown;
  try {
    doc = yaml.load(block);
  } catch (error) {
    if (error instanceof yaml.YAMLException) {
      const line = error.mark ? ` (line ${error.mark.line + 1} of the block)` : '';
      throw new Error(`YAML syntax error: ${error.reason}${line}`);
    }
    throw error;
  }
  parseRadar(doc);
}

function describe(error: unknown): string {
  if (error instanceof RadarDataError) return error.problems.join(' ');
  return error instanceof Error ? error.message : String(error);
}
