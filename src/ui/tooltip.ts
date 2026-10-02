import { initials } from '../radar/render.ts';
import type { Entry, Ring, Sector } from '../types.ts';
import { escapeHtml, miniMarkdown, safeUrl } from './text.ts';

export interface TooltipContext {
  ring: Ring;
  sector: Sector;
  /** The same processed glyph the radar shows; a monogram stands in until it loads. */
  glyph?: string;
  sectorColor: string;
  ringColor: string;
}

const MOVEMENT_TEXT: Record<NonNullable<Entry['moved']>, string> = {
  new: 'New on the radar',
  up: 'Moved closer to the center',
  down: 'Moved away from the center',
};

const EXTERNAL_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3h7v7M13 3 4 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class Tooltip {
  readonly el: HTMLDivElement;
  private anchor: Element | null = null;
  pinned = false;
  onClose: () => void = () => {};

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tip';
    this.el.setAttribute('role', 'dialog');
    this.el.hidden = true;
    host.append(this.el);
    this.el.addEventListener('click', (event) => {
      if ((event.target as Element).closest('.tip-close')) this.onClose();
    });
  }

  get current(): string | null {
    return this.el.hidden ? null : (this.el.dataset.id ?? null);
  }

  show(entry: Entry, ctx: TooltipContext, anchor: Element, pinned: boolean) {
    this.pinned = pinned;
    this.anchor = anchor;
    this.el.classList.toggle('is-pinned', pinned);
    if (this.el.dataset.id !== entry.id || this.el.hidden) {
      this.el.dataset.id = entry.id;
      this.el.style.setProperty('--sc', ctx.sectorColor);
      this.el.style.setProperty('--rc', ctx.ringColor);
      this.el.setAttribute('aria-label', entry.name);
      this.el.innerHTML = this.template(entry, ctx);
      if (ctx.glyph) this.el.querySelector<HTMLElement>('.tip-glyph')?.style.setProperty('--glyph', `url("${ctx.glyph}")`);
    }
    this.el.hidden = false;
    this.place();
  }

  hide() {
    this.el.hidden = true;
    this.pinned = false;
    this.anchor = null;
    delete this.el.dataset.id;
  }

  /** Beside the blip, flipping to whichever side has room; a bottom sheet on phones (CSS). */
  place() {
    if (!this.anchor || this.el.hidden) return;
    if (window.matchMedia('(max-width: 760px)').matches) {
      this.el.style.left = this.el.style.top = '';
      return;
    }
    const gap = 14;
    const margin = 12;
    const a = this.anchor.getBoundingClientRect();
    const { width, height } = this.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = a.right + gap;
    let side = 'right';
    if (left + width > vw - margin) {
      left = a.left - gap - width;
      side = 'left';
    }
    if (left < margin) left = Math.max(margin, Math.min(vw - width - margin, a.left + a.width / 2 - width / 2));
    const top = Math.max(margin, Math.min(vh - height - margin, a.top + a.height / 2 - 34));

    this.el.dataset.side = side;
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  private template(entry: Entry, { ring, sector, glyph }: TooltipContext): string {
    const mark = glyph ? '<span class="tip-glyph"></span>' : `<span class="tip-monogram">${escapeHtml(initials(entry.name))}</span>`;
    const logo = `<div class="tip-logo" aria-hidden="true">${mark}</div>`;
    const moved = entry.moved ? `<p class="tip-moved">${MOVEMENT_TEXT[entry.moved]}</p>` : '';
    const description = entry.description ? `<div class="tip-desc">${miniMarkdown(entry.description)}</div>` : '';
    const rationale = entry.rationale
      ? `<section class="tip-why"><h4>Why ${escapeHtml(ring.name)}</h4>${miniMarkdown(entry.rationale)}</section>`
      : '';
    const links = entry.links
      .map((link) => {
        const url = safeUrl(link.url);
        const cls = link.primary ? ' class="is-primary"' : '';
        return url ? `<a href="${escapeHtml(url)}"${cls} target="_blank" rel="noopener">${escapeHtml(link.title)}${EXTERNAL_ICON}</a>` : '';
      })
      .join('');
    const tags = entry.tags.length ? `<ul class="tip-tags">${entry.tags.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : '';
    const dateRows = [
      entry.added && `<div><dt>Added</dt><dd>${escapeHtml(entry.added)}</dd></div>`,
      entry.updated && `<div><dt>Updated</dt><dd>${escapeHtml(entry.updated)}</dd></div>`,
    ].filter(Boolean);
    const dates = dateRows.length ? `<dl class="tip-dates">${dateRows.join('')}</dl>` : '';

    return `
      <header class="tip-head">
        ${logo}
        <div class="tip-title">
          <h3>${escapeHtml(entry.name)}</h3>
          <p class="tip-where"><span class="tip-ring">${escapeHtml(ring.name)}</span><span class="tip-sector">${escapeHtml(sector.name)}</span></p>
        </div>
        <button type="button" class="tip-close" aria-label="Close">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </header>
      ${moved}${description}${rationale}${tags}${dates}
      ${links ? `<footer class="tip-links">${links}</footer>` : ''}`;
  }
}
