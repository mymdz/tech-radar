import './styles.css';
import { RadarDataError } from './data/parse.ts';
import { resolveSource } from './data/source.ts';
import { loadGlyph } from './icons/glyph.ts';
import { ringPaint, sectorPaint } from './paint.ts';
import { resolveIconUrl } from './icons/resolve.ts';
import { computeLayout, RADIUS, VIEW_SIZE } from './radar/layout.ts';
import { renderRadar, SWEEP_MS, type RadarView } from './radar/render.ts';
import { Panel } from './ui/panel.ts';
import { escapeHtml } from './ui/text.ts';
import { Tooltip } from './ui/tooltip.ts';
import type { Entry, RadarData } from './types.ts';

const HIDE_DELAY_MS = 160;

async function main() {
  const app = document.getElementById('app')!;
  const source = resolveSource();
  let data: RadarData;
  try {
    data = await source.load();
  } catch (error) {
    showError(app, source.label, error);
    return;
  }
  document.title = data.title;
  mount(app, data);
}

function mount(app: HTMLElement, data: RadarData) {
  const layout = computeLayout(data);
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  const iconUrls = new Map(data.entries.map((e) => [e.id, resolveIconUrl(e.icon, e.links[0]?.url)]));
  const glyphs = new Map<string, string>();
  const sectorColors = sectorPaint(data);
  const ringColors = ringPaint(data);
  const tooltip = new Tooltip(document.body);

  let pinned: string | null = null;
  let hideTimer = 0;

  const cancelHide = () => window.clearTimeout(hideTimer);
  const scheduleHide = () => {
    cancelHide();
    if (pinned) return;
    hideTimer = window.setTimeout(() => {
      tooltip.hide();
      view.setSelected(null);
    }, HIDE_DELAY_MS);
  };

  const open = (entry: Entry, anchor: Element, pin: boolean) => {
    cancelHide();
    const ring = data.rings.find((r) => r.id === entry.ring)!;
    const sector = data.sectors.find((s) => s.id === entry.sector)!;
    tooltip.show(
      entry,
      {
        ring,
        sector,
        glyph: glyphs.get(entry.id),
        sectorColor: sectorColors.get(sector.id)!,
        ringColor: ringColors.get(ring.id)!,
      },
      anchor,
      pin,
    );
    pinned = pin ? entry.id : null;
    view.setSelected(entry.id);
    panel.setSelected(pin ? entry.id : null);
  };

  const close = () => {
    const wasPinned = pinned;
    pinned = null;
    tooltip.hide();
    view.setSelected(null);
    panel.setSelected(null);
    return wasPinned;
  };
  // Returning focus to a blip after closing must not reopen its tooltip.
  let skipFocusOpen: string | null = null;
  tooltip.onClose = () => {
    const id = tooltip.current;
    close();
    const blip = id ? view.blip(id) : undefined;
    if (blip && document.activeElement !== blip) {
      skipFocusOpen = id;
      blip.focus({ preventScroll: true });
    }
  };

  const view: RadarView = renderRadar(data, layout, {
    onEnter(entry, target) {
      if (skipFocusOpen === entry.id) {
        skipFocusOpen = null;
        return;
      }
      if (pinned && pinned !== entry.id) return;
      open(entry, target, pinned === entry.id);
    },
    onLeave: scheduleHide,
    onActivate(entry, target) {
      if (pinned === entry.id) close();
      else open(entry, target, true);
    },
    onSectorHover: (id) => view.setActiveSector(id),
  });

  const panel = new Panel(data, {
    onFilter(hidden) {
      view.setHidden(hidden);
      if (pinned && hidden.has(pinned)) close();
    },
    onHover: (ids) => view.setSpotlight(ids),
    onSelect(id) {
      const blip = view.blip(id);
      if (!blip) return;
      if (window.matchMedia('(max-width: 900px)').matches) blip.scrollIntoView({ block: 'center', behavior: 'smooth' });
      open(byId.get(id)!, blip, true);
    },
  });

  tooltip.el.addEventListener('pointerenter', cancelHide);
  tooltip.el.addEventListener('pointerleave', scheduleHide);
  document.addEventListener('click', (event) => {
    if (!pinned) return;
    const target = event.target as Element;
    if (!target.closest('.tip, .blip, .item')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !tooltip.el.hidden) tooltip.onClose();
  });
  window.addEventListener('resize', () => tooltip.place());
  window.addEventListener('scroll', () => (pinned ? tooltip.place() : scheduleHide()), { passive: true, capture: true });

  const stage = document.createElement('main');
  stage.className = 'stage';
  const wrap = document.createElement('div');
  wrap.className = 'radar-wrap';
  wrap.style.setProperty('--radar-inset', `${((VIEW_SIZE / 2 - RADIUS) / VIEW_SIZE) * 100}%`);
  wrap.style.setProperty('--sweep-ms', `${SWEEP_MS}ms`);
  const sweep = document.createElement('div');
  sweep.className = 'sweep';
  sweep.setAttribute('aria-hidden', 'true');
  wrap.append(view.svg, sweep);
  stage.append(wrap);
  app.replaceChildren(stage, panel.el);

  loadGlyphs(data, iconUrls, (ids, url) => {
    for (const id of ids) glyphs.set(id, url);
    view.applyGlyph(ids, url);
    panel.applyGlyph(ids, url);
  });
}

/** One request per distinct icon, shared by every entry that uses it. */
function loadGlyphs(data: RadarData, iconUrls: Map<string, string | undefined>, apply: (ids: string[], dataUrl: string) => void) {
  const groups = new Map<string, { url: string; entry: Entry; ids: string[] }>();
  for (const entry of data.entries) {
    const url = iconUrls.get(entry.id);
    if (!url) continue;
    const key = `${entry.iconMode}|${url}`;
    const group = groups.get(key) ?? { url, entry, ids: [] };
    group.ids.push(entry.id);
    groups.set(key, group);
  }
  for (const { url, entry, ids } of groups.values()) {
    loadGlyph(url, entry.iconMode).then((glyph) => glyph && apply(ids, glyph));
  }
}

function showError(app: HTMLElement, sourceLabel: string, error: unknown) {
  const problems = error instanceof RadarDataError ? error.problems : [(error as Error).message];
  app.innerHTML = `
    <section class="failure" role="alert">
      <h1>The radar couldn’t load</h1>
      <p>Source: <code>${escapeHtml(sourceLabel)}</code></p>
      <ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      <p class="failure-hint">Fix the data and reload the page.</p>
    </section>`;
}

main();
