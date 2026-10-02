import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the Vite build. Hashed files under /assets are immutable; the rest
 * (index.html) is revalidated so a deploy shows up on the next load.
 */
export function staticFiles(dir: string) {
  const root = path.resolve(dir);

  return async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    let relative: string;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return plain(res, 400, 'Bad request');
    }
    if (relative.endsWith('/')) relative += 'index.html';

    const file = path.resolve(root, `.${relative}`);
    if (!file.startsWith(root + path.sep)) return plain(res, 404, 'Not found');

    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return plain(res, 404, 'Not found');

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': relative.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  };
}

export function plain(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
