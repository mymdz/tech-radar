/**
 * Expands an icon spec from the data file into a fetchable URL.
 *
 *   simple-icons:nginx        → https://cdn.simpleicons.org/nginx      (≈3000 brand marks)
 *   iconify:logos:kubernetes  → https://api.iconify.design/logos/kubernetes.svg  (200k+ icons)
 *   devicon:go                → devicon "original" SVG
 *   favicon:grafana.com       → the site's favicon
 *   https://…/logo.png        → used as is
 *
 * Without an icon, the entry's first link is used to fetch a favicon.
 * Kept free of DOM and bundler APIs so `scripts/check-icons.ts` and the server can reuse it in Node.
 */
export function resolveIconUrl(spec: string | undefined, fallbackLink?: string): string | undefined {
  return resolveIcon(spec, fallbackLink)?.url;
}

export interface IconSource {
  /** What the page fetches, and the key the server caches it under. */
  url: string;
  /** Set for a site's favicon: the server looks it up on the site itself, `url` goes through icon.horse. */
  site?: string;
}

export function resolveIcon(spec: string | undefined, fallbackLink?: string): IconSource | undefined {
  if (!spec) return fallbackLink ? favicon(hostOf(fallbackLink)) : undefined;

  const [provider, ...rest] = spec.split(':');
  const value = rest.join(':');
  switch (provider) {
    case 'simple-icons':
    case 'si':
      return { url: `https://cdn.simpleicons.org/${encodeURIComponent(value)}` };
    case 'iconify': {
      const [set, name] = value.split(':');
      return { url: `https://api.iconify.design/${encodeURIComponent(set)}/${encodeURIComponent(name)}.svg` };
    }
    case 'devicon':
      return { url: `https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/${value}/${value}-original.svg` };
    case 'favicon':
      return favicon(value);
    default:
      return { url: spec };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * The browser can only process a favicon on a canvas with CORS headers, which
 * sites rarely send for theirs — icon.horse does. The server needs no CORS and
 * finds the favicon on the site itself (server/favicon.ts); icon.horse is the
 * page's fallback when the server has no copy.
 */
function favicon(host: string): IconSource {
  return { url: `https://icon.horse/icon/${encodeURIComponent(host)}`, site: host };
}
