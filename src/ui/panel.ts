import { ringPaint, sectorPaint } from '../paint.ts';
import type { Entry, RadarData } from '../types.ts';
import { initials } from '../radar/render.ts';
import { escapeHtml } from './text.ts';
import { bindThemeToggle, THEME_TOGGLE_HTML } from './theme.ts';

export interface PanelHandlers {
  onFilter(hidden: Set<string>): void;
  onHover(ids: Set<string> | null): void;
  onSelect(id: string): void;
}

const dateFormat = new Intl.DateTimeFormat('en-GB',{ day: 'numeric', month: 'long', year: 'numeric' });

export class Panel {
  readonly el: HTMLElement;
  private readonly data: RadarData;
  private readonly handlers: PanelHandlers;
  private readonly hiddenRings = new Set<string>();
  private readonly sectorColor: Map<string, string>;
  private readonly ringColor: Map<string, string>;
  private query = '';

  constructor(data: RadarData, handlers: PanelHandlers) {
    this.data = data;
    this.handlers = handlers;
    this.sectorColor = sectorPaint(data);
    this.ringColor = ringPaint(data);
    this.el = document.createElement('aside');
    this.el.className = 'panel';
    this.el.innerHTML = this.template();
    this.bind();
  }

  applyGlyph(entryIds: string[], dataUrl: string) {
    for (const id of entryIds) {
      const glyph = this.el.querySelector<HTMLElement>(`.item[data-id="${CSS.escape(id)}"] .item-glyph`);
      if (!glyph) continue;
      glyph.textContent = '';
      glyph.classList.add('has-glyph');
      glyph.style.setProperty('--glyph', `url("${dataUrl}")`);
    }
  }

  setSelected(id: string | null) {
    this.el.querySelectorAll('.item').forEach((item) => item.classList.toggle('is-selected', (item as HTMLElement).dataset.id === id));
  }

  private template(): string {
    const { title, subtitle, updated, rings, sectors, entries, notice } = this.data;
    const countIn = (ringId: string) => entries.filter((e) => e.ring === ringId).length;

    const legend = rings
      .map(
        (ring) => `
        <li>
          <button type="button" class="ring-toggle" data-ring="${escapeHtml(ring.id)}" aria-pressed="true" style="--rc:${escapeHtml(this.ringColor.get(ring.id)!)}">
            <span class="ring-dot" aria-hidden="true"></span>
            <span class="ring-name">${escapeHtml(ring.name)}</span>
            <span class="ring-count">${countIn(ring.id)}</span>
            ${ring.description ? `<span class="ring-desc">${escapeHtml(ring.description)}</span>` : ''}
          </button>
        </li>`,
      )
      .join('');

    const ringOrder = new Map(rings.map((r, i) => [r.id, i]));
    const groups = sectors
      .map((sector) => {
        const items = entries
          .filter((e) => e.sector === sector.id)
          .sort((a, b) => ringOrder.get(a.ring)! - ringOrder.get(b.ring)! || a.name.localeCompare(b.name))
          .map((entry) => this.itemTemplate(entry))
          .join('');
        return `
        <section class="group" data-sector="${escapeHtml(sector.id)}">
          <h2 class="group-title">${escapeHtml(sector.name)}</h2>
          <ul class="items">${items || '<li class="group-empty">Nothing here yet</li>'}</ul>
        </section>`;
      })
      .join('');

    return `
      <header class="panel-head">
        ${THEME_TOGGLE_HTML}
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ''}
        ${updated ? `<p class="updated">Updated ${dateFormat.format(updated)}</p>` : ''}
        ${notice ? `<p class="notice" role="status"><strong>Showing the last working version.</strong> Fix the Outline document: ${escapeHtml(notice)}</p>` : ''}
      </header>
      <ul class="legend" aria-label="Rings: select to hide or show">${legend}</ul>
      <div class="search">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input type="search" placeholder="Search technologies or tags" aria-label="Search the radar" autocomplete="off">
      </div>
      <nav class="list" aria-label="All technologies">
        ${groups}
        <p class="credit">Powered by <a href="https://github.com/mymdz/tech-radar" target="_blank" rel="noopener">mymdz/tech-radar</a></p>
      </nav>
      <p class="empty" hidden>No matches. Check the search or turn hidden rings back on.</p>`;
  }

  private itemTemplate(entry: Entry): string {
    const ring = this.data.rings.find((r) => r.id === entry.ring)!;
    const search = [entry.name, ...entry.tags, entry.description ?? ''].join(' ').toLowerCase();
    return `
      <li>
        <button type="button" class="item" data-id="${escapeHtml(entry.id)}" data-ring="${escapeHtml(ring.id)}" data-search="${escapeHtml(search)}" style="--c:${escapeHtml(this.sectorColor.get(entry.sector)!)}">
          <span class="item-glyph" aria-hidden="true">${escapeHtml(initials(entry.name))}</span>
          <span class="item-name">${escapeHtml(entry.name)}</span>
          <span class="item-ring">${escapeHtml(ring.name)}</span>
        </button>
      </li>`;
  }

  private bind() {
    bindThemeToggle(this.el.querySelector<HTMLButtonElement>('.theme-toggle')!);

    this.el.querySelectorAll<HTMLButtonElement>('.ring-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const ring = button.dataset.ring!;
        if (this.hiddenRings.has(ring)) this.hiddenRings.delete(ring);
        else this.hiddenRings.add(ring);
        button.setAttribute('aria-pressed', String(!this.hiddenRings.has(ring)));
        this.refilter();
      });
    });

    const input = this.el.querySelector<HTMLInputElement>('.search input')!;
    input.addEventListener('input', () => {
      this.query = input.value.trim().toLowerCase();
      this.refilter();
    });

    // The spotlight is a hover/keyboard preview. Touch has no "pointer left" after a
    // tap, and a tapped button keeps focus, so on phones it used to stick and dim
    // the whole radar: touch pointers and non-keyboard focus don't trigger it.
    const list = this.el.querySelector('.list')!;
    list.addEventListener('pointerover', (event) => {
      if ((event as PointerEvent).pointerType === 'touch') return;
      const item = (event.target as Element).closest<HTMLElement>('.item');
      const title = (event.target as Element).closest('.group-title');
      if (item) this.handlers.onHover(new Set([item.dataset.id!]));
      else if (title) this.handlers.onHover(this.idsInSector(title.parentElement!.dataset.sector!));
    });
    list.addEventListener('pointerleave', () => this.handlers.onHover(null));
    list.addEventListener('focusin', (event) => {
      const item = (event.target as Element).closest<HTMLElement>('.item');
      if (item?.matches(':focus-visible')) this.handlers.onHover(new Set([item.dataset.id!]));
    });
    list.addEventListener('focusout', () => this.handlers.onHover(null));
    list.addEventListener('click', (event) => {
      const item = (event.target as Element).closest<HTMLElement>('.item');
      if (item) {
        event.stopPropagation();
        this.handlers.onSelect(item.dataset.id!);
      }
    });
  }

  private idsInSector(sectorId: string): Set<string> {
    return new Set(this.data.entries.filter((e) => e.sector === sectorId).map((e) => e.id));
  }

  private refilter() {
    const hidden = new Set<string>();
    this.el.querySelectorAll<HTMLElement>('.item').forEach((item) => {
      const visible = !this.hiddenRings.has(item.dataset.ring!) && (!this.query || item.dataset.search!.includes(this.query));
      item.parentElement!.hidden = !visible;
      if (!visible) hidden.add(item.dataset.id!);
    });
    const filtering = this.query !== '' || this.hiddenRings.size > 0;
    this.el.querySelectorAll<HTMLElement>('.group').forEach((group) => {
      const items = [...group.querySelectorAll<HTMLElement>('.items > li:not(.group-empty)')];
      group.hidden = filtering && items.every((li) => li.hidden);
    });
    this.el.querySelector<HTMLElement>('.empty')!.hidden = hidden.size < this.data.entries.length;
    this.handlers.onFilter(hidden);
  }
}
