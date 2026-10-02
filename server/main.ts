/**
 * Serves the radar page and its data.
 *
 * The page is the static Vite build (STATIC_DIR). Its data file, /radar.yaml,
 * comes from the first ```yaml block of an Outline document, so the radar is
 * edited in Outline — by hand or by Claude through the Outline connector — with
 * no redeploy. Without Outline settings it is a plain file: RADAR_FILE, by
 * default the radar.yaml bundled into STATIC_DIR.
 *
 * /icon?url=… serves the icons that data refers to from a file cache
 * (ICON_CACHE_DIR); the page goes to the icon's own URL when that fails.
 *
 * Runs directly on Node 24 (native type stripping), no build step.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { IconCache } from './icons.ts';
import { log } from './log.ts';
import { fetchDocument, type OutlineDocument } from './outline.ts';
import { RadarSource } from './radar-source.ts';
import { plain, staticFiles } from './static.ts';

const env = (key: string, fallback = '') => process.env[key]?.trim() || fallback;

const port = Number(env('PORT', '8080'));
const staticDir = env('STATIC_DIR', 'dist');
const radarFile = env('RADAR_FILE', path.join(staticDir, 'radar.yaml'));
const ttlSeconds = Number(env('CACHE_TTL_SECONDS', '30'));
const outline: OutlineDocument = {
  baseUrl: env('OUTLINE_BASE_URL'),
  token: env('OUTLINE_API_TOKEN') || undefined,
  documentId: env('OUTLINE_DOCUMENT_ID') || undefined,
  shareId: env('OUTLINE_SHARE_ID') || undefined,
};

if ((outline.documentId || outline.shareId) && !outline.baseUrl) {
  log('error', 'OUTLINE_BASE_URL is needed to read the radar from Outline, e.g. https://outline.example.com');
  process.exit(1);
}
if (outline.documentId && !outline.token) {
  log('error', 'OUTLINE_DOCUMENT_ID needs OUTLINE_API_TOKEN; for a public share use OUTLINE_SHARE_ID');
  process.exit(1);
}
if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
  log('error', 'CACHE_TTL_SECONDS must be a non-negative number');
  process.exit(1);
}

const radar = outline.documentId || outline.shareId
  ? new RadarSource(() => fetchDocument(outline), ttlSeconds * 1000, log)
  : undefined;
if (radar) log('info', 'radar data from Outline', { baseUrl: outline.baseUrl, ttlSeconds });
else log('info', 'radar data from a file', { file: radarFile });

const serveStatic = staticFiles(staticDir);

const icons = await IconCache.open(env('ICON_CACHE_DIR', '.icon-cache'), log);

/** The radar data being served right now: from Outline, or the file. */
async function currentRadarYaml(): Promise<string | undefined> {
  if (radar) return (await radar.current()).body;
  // Read every time: the file can be edited while the server runs, and it is small.
  return readFile(radarFile, 'utf8').catch(() => undefined);
}

/**
 * The page only ever talks to itself, Google Fonts and the icon CDNs:
 *   - scripts: only our own files (no inline, no eval);
 *   - styles: ours + Google Fonts; inline style *attributes* are how the radar
 *     passes per-entry colors, so those are allowed, <style> blocks are not;
 *   - connect: our API plus https: — when /icon fails, the page fetches the icon
 *     from its own URL, which comes from the data and can be any host;
 *   - images: glyphs are canvas output (data:) and blob: URLs.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "connect-src 'self' https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** A cached SVG opened directly in a tab must not run anything on our origin. */
const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  // Everything, URL parsing included, stays inside the try: an exception here
  // is an unhandled rejection, and Node exits on those — one malformed request
  // (`GET http://[`) used to take the whole server down.
  let pathname = '?';
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
    const url = new URL(req.url ?? '/', 'http://localhost');
    pathname = url.pathname;

    if (pathname === '/healthz') return plain(res, 200, 'ok');

    if (pathname === '/radar.yaml' && radar) {
      const { body, updatedAt, warning } = await radar.current();
      res.setHeader('Cache-Control', 'no-store');
      if (body === undefined) return plain(res, 502, `The radar couldn’t be loaded from Outline: ${warning}`);
      void icons?.follow(body);
      // Header values should stay ASCII; the page decodes it back.
      if (warning) res.setHeader('X-Radar-Warning', encodeURIComponent(warning));
      if (updatedAt) res.setHeader('X-Radar-Updated', updatedAt);
      res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (pathname === '/radar.yaml') {
      const body = await currentRadarYaml();
      if (body === undefined) return plain(res, 404, `No radar data at ${radarFile}`);
      res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    // Any non-200 here sends the page to the icon's own URL instead.
    if (pathname === '/icon' && icons) {
      const radarYaml = await currentRadarYaml();
      if (radarYaml) void icons.follow(radarYaml);
      const iconUrl = url.searchParams.get('url') ?? '';
      if (!icons.allows(iconUrl)) return plain(res, 404, 'Not an icon of this radar');
      const icon = await icons.get(iconUrl);
      if (!icon) return plain(res, 502, 'The icon couldn’t be fetched');
      res.writeHead(200, {
        'Content-Type': icon.type,
        'Content-Length': icon.body.length,
        'Content-Security-Policy': ICON_CSP,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(req.method === 'HEAD' ? undefined : icon.body);
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    if (error instanceof TypeError && pathname === '?') {
      if (!res.headersSent) plain(res, 400, 'Bad request');
      return;
    }
    log('error', 'request failed', { path: pathname, error: String(error) });
    if (!res.headersSent) plain(res, 500, 'Internal error');
    else res.destroy();
  }
});

// Behind a reverse proxy, a request that trickles in for longer than this is not a real client.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;

// Last line of defence: log instead of dying if something still slips through.
process.on('unhandledRejection', (reason) => log('error', 'unhandled rejection', { error: String(reason) }));

server.listen(port, () => log('info', 'listening', { port }));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
