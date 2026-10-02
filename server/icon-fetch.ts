import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * Downloads one icon for the server-side cache, defensively: the URL comes from
 * the radar data, i.e. from anyone who can edit the Outline document.
 *
 *   - only http/https on the default port, at most a few redirects, each hop
 *     checked again;
 *   - every address a host resolves to must be public — checked in the socket's
 *     own DNS lookup, so a rebinding DNS can't swap in 127.0.0.1 after the check;
 *     this keeps the server from being a window into the docker network;
 *   - the body is capped while it streams (Content-Length is not trusted) and
 *     again after decompression, and the whole fetch has one deadline;
 *   - the bytes must look like an image by their signature, whatever the
 *     Content-Type says (favicons are often served as text/plain or octet-stream).
 */

export interface Icon {
  body: Buffer;
  type: string;
  /** Where it was actually found, when that differs from the URL asked for (a site's favicon). */
  from?: string;
}

export interface FetchIconOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Aborts along with the caller's, e.g. one deadline over several fetches. */
  signal?: AbortSignal;
  /** Tests point these at a local server; in production only public addresses on default ports pass. */
  isAllowedAddress?: (address: string) => boolean;
  anyPort?: boolean;
}

export interface FetchOptions extends FetchIconOptions {
  accept?: string;
  /** Keep the first maxBytes instead of failing: enough of an HTML page to read its <head>. */
  truncate?: boolean;
}

export const MAX_ICON_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8_000;
const IMAGES = 'image/avif,image/webp,image/svg+xml,image/*;q=0.8,*/*;q=0.5';

export async function fetchIcon(url: string, options: FetchIconOptions = {}): Promise<Icon> {
  const { body } = await fetchLimited(url, { ...options, accept: IMAGES });
  const type = sniffImageType(body);
  if (!type) throw new Error('not an image');
  return { body, type };
}

/** One guarded GET: the body, and the URL it finally came from after redirects. */
export async function fetchLimited(url: string, options: FetchOptions = {}): Promise<{ body: Buffer; url: URL }> {
  const { maxBytes = MAX_ICON_BYTES, timeoutMs = TIMEOUT_MS, isAllowedAddress = isPublicAddress, anyPort = false } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; tech-radar-icons/1.0)',
    Accept: options.accept ?? '*/*',
    'Accept-Encoding': 'identity',
  };

  let target = new URL(url);
  for (let hop = 0; ; hop++) {
    checkTarget(target, isAllowedAddress, anyPort);
    const response = await get(target, headers, signal, isAllowedAddress);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400 && response.headers.location) {
      response.destroy();
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      target = new URL(response.headers.location, target);
      continue;
    }
    if (status !== 200) {
      response.destroy();
      throw new Error(`HTTP ${status}`);
    }

    const raw = await readLimited(response, maxBytes, options.truncate ?? false);
    return { body: decode(raw, response.headers['content-encoding'], maxBytes), url: target };
  }
}

function checkTarget(url: URL, isAllowedAddress: (address: string) => boolean, anyPort: boolean) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${url.protocol} URLs are not fetched`);
  // Icons live on standard ports; anything else is more likely a probe.
  if (url.port && !anyPort) throw new Error('non-default ports are not fetched');
  if (url.username || url.password) throw new Error('URLs with credentials are not fetched');
  // An IP literal never reaches the lookup below, so it is checked here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isAllowedAddress(host)) throw new Error(`${host} is not a public address`);
}

function get(url: URL, headers: Record<string, string>, signal: AbortSignal, isAllowedAddress: (address: string) => boolean): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { headers, signal, lookup: guardedLookup(isAllowedAddress) }, resolve);
    request.on('error', reject);
  });
}

function guardedLookup(isAllowedAddress: (address: string) => boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      const blocked = addresses.find((a) => !isAllowedAddress(a.address));
      if (blocked || addresses.length === 0) {
        return callback(new Error(`${hostname} resolves to ${blocked?.address ?? 'nothing'}, not a public address`), '');
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

async function readLimited(response: http.IncomingMessage, maxBytes: number, truncate: boolean): Promise<Buffer> {
  const declared = Number(response.headers['content-length']);
  if (declared > maxBytes && !truncate) {
    response.destroy();
    throw new Error(`too large: ${declared} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Leaving the loop (break or throw) destroys the response and its socket.
  for await (const chunk of response as AsyncIterable<Buffer>) {
    if (size + chunk.length > maxBytes) {
      if (!truncate) throw new Error(`larger than ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, maxBytes - size));
      size = maxBytes;
      break;
    }
    size += chunk.length;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/**
 * We ask for identity, but some servers compress anyway; a zip bomb stops at
 * maxBytes. The flush mode lets a truncated page decode as far as it goes.
 */
function decode(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const options = { maxOutputLength: maxBytes, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  try {
    switch (encoding?.trim().toLowerCase() || 'identity') {
      case 'identity':
        return body;
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(body, options);
      case 'deflate':
        return zlib.inflateSync(body, options);
      case 'br':
        return zlib.brotliDecompressSync(body, { maxOutputLength: maxBytes, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    }
  } catch {
    throw new Error(`${encoding} body is corrupt or larger than ${maxBytes} bytes`);
  }
  throw new Error(`unsupported Content-Encoding: ${encoding}`);
}

/** The image type by its signature bytes, or undefined if it isn't an image a browser can draw. */
export function sniffImageType(body: Buffer): string | undefined {
  const ascii = (start: number, end: number) => body.toString('latin1', start, end);
  const bytes = (...signature: number[]) => signature.every((value, i) => body[i] === value);

  if (bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (bytes(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 12) === 'ftypavif') return 'image/avif';
  if (looksLikeSvg(body)) return 'image/svg+xml';
  return undefined;
}

function looksLikeSvg(body: Buffer): boolean {
  const text = body.toString('utf8', 0, Math.min(body.length, 64 * 1024)).replace(/^﻿/, '').trimStart();
  return text.startsWith('<') && /<svg[\s>]/i.test(text) && !/<html[\s>]/i.test(text);
}

/** Loopback, private, link-local, CGNAT, multicast, documentation and other non-routable ranges. */
const NON_PUBLIC = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: would reach IPv4 ranges through a translator
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(address, prefix, 'ipv6');
}

/** IPv4-mapped IPv6 (::ffff:127.0.0.1) is matched against the IPv4 ranges by BlockList itself. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  try {
    return !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}
