/**
 * Light/dark switch. The initial theme is set by an inline script in
 * index.html before first paint (stored choice, else the system setting), so
 * there is no flash; this module only handles the button and system changes.
 */

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';
const THEME_COLOR: Record<Theme, string> = { light: '#fcfcfb', dark: '#0e0c0b' };

const SUN =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" class="icon-sun"><circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 1.8v2.2M10 16v2.2M1.8 10H4M16 10h2.2M4.2 4.2l1.6 1.6M14.2 14.2l1.6 1.6M4.2 15.8l1.6-1.6M14.2 5.8l1.6-1.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const MOON =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" class="icon-moon"><path d="M16.2 12.6A6.8 6.8 0 0 1 7.4 3.8a6.8 6.8 0 1 0 8.8 8.8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

export const THEME_TOGGLE_HTML = `<button type="button" class="theme-toggle">${SUN}${MOON}</button>`;

const current = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function apply(theme: Theme, button: HTMLButtonElement) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  // The button names the action it performs, not the current state.
  button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  button.title = button.getAttribute('aria-label')!;
}

export function bindThemeToggle(button: HTMLButtonElement) {
  apply(current(), button);

  button.addEventListener('click', () => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisted (private mode); the switch still works for this visit.
    }
    apply(next, button);
  });

  // Follow the system until the viewer picks a theme explicitly.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!stored()) apply(event.matches ? 'dark' : 'light', button);
  });
}
