import { NO_SESSION_MESSAGE, sessionService } from './session.service.js';
import { isLoggedIn } from './auth.service.js';
import { httpService } from './http.service.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sfccError } from '../spec/extract.js';
import { dataPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

/**
 * Helpers for the tools that chain several carrefour.it calls in code
 * (checkout, shopping lists), where one-request JSON definitions fall short.
 */

export type Json = Record<string, unknown>;

/** A failure worth showing the user as is. */
export class SfccError extends Error {}

const XHR = { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' };
/** What a browser sends for a page: SFCC templates may render differently for an XHR. */
const PAGE = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

async function send(
  method: 'GET' | 'POST',
  url: string,
  opts: {
    form?: Record<string, string>;
    urlencoded?: Record<string, string>;
    query?: Record<string, string>;
    page?: boolean;
  }
): Promise<{ target: URL; data: unknown }> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) target.searchParams.set(k, v);
  const headers: Record<string, string> = opts.page ? { ...PAGE } : { ...XHR };
  let body: FormData | string | undefined;
  if (opts.form) {
    body = new FormData();
    for (const [k, v] of Object.entries(opts.form)) body.append(k, v);
  } else if (opts.urlencoded) {
    body = new URLSearchParams(opts.urlencoded).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const result = await httpService.send({ method, url: target.toString(), headers, body });
  if (!result.ok) throw new SfccError(`HTTP ${result.status} on ${target.pathname}`);
  return { target, data: result.data };
}

/** One SFCC call answering JSON; form bodies go as multipart, like the site's XHRs. */
export async function sfccJson(
  method: 'GET' | 'POST',
  url: string,
  opts: { form?: Record<string, string>; query?: Record<string, string> } = {}
): Promise<Json> {
  const { target, data } = await send(method, url, opts);
  if (typeof data !== 'object' || data === null) {
    throw new SfccError(`${target.pathname} did not answer with JSON — the session may have expired.`);
  }
  return data as Json;
}

/** Redact the CSRF tokens a page embeds (hidden inputs, data attributes). */
export function redactTokens(html: string): string {
  return html
    .replace(/(name="csrf_token"[^>]*value=")[^"]*"/g, '$1<redacted>"')
    .replace(/(value=")[^"]*("[^>]*name="csrf_token")/g, '$1<redacted>$2')
    .replace(/(data-option-token-value=")[^"]*"/g, '$1<redacted>"')
    .replace(/(csrf_token=)[^&"'\s]+/g, '$1<redacted>');
}

/**
 * With CARREFOUR_DEBUG_HTML set, keep a copy of every HTML answer in
 * <data>/debug, tokens redacted, so a parser can be fixed from what the server
 * really received. Off by default: pages carry personal data.
 */
function dumpHtml(target: URL, html: string): void {
  if (!process.env.CARREFOUR_DEBUG_HTML) return;
  try {
    const dir = dataPath('debug');
    mkdirSync(dir, { recursive: true });
    const name = `${target.pathname.replace(/[^a-zA-Z0-9-]+/g, '_')}_${Date.now()}.html`;
    writeFileSync(join(dir, name), redactTokens(html), { mode: 0o600 });
    logger.info('HTML answer saved for debugging', { file: join(dir, name) });
  } catch (error) {
    logger.error('Could not save the HTML answer', { error: String(error) });
  }
}

/** One SFCC call answering HTML: a fragment (default) or, with `page`, a whole page as a browser asks for it. */
export async function sfccHtml(
  method: 'GET' | 'POST',
  url: string,
  opts: { urlencoded?: Record<string, string>; query?: Record<string, string>; page?: boolean } = {}
): Promise<string> {
  const { target, data } = await send(method, url, opts);
  const html = typeof data === 'string' ? data : JSON.stringify(data);
  dumpHtml(target, html);
  return html;
}

/** Throw the failure SFCC reported in `data` for `step`, if any. */
export function check(step: string, data: Json): Json {
  const failure = sfccError(data);
  if (failure) throw new SfccError(`${step}: ${failure.message}`);
  return data;
}

export async function requireSignedIn(): Promise<void> {
  if (!sessionService.hasSession()) throw new SfccError(NO_SESSION_MESSAGE);
  if ((await isLoggedIn()) === false) {
    throw new SfccError(`carrefour.it no longer sees you as signed in.\n\n${NO_SESSION_MESSAGE}`);
  }
}
