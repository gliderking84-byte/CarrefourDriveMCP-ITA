import { NO_SESSION_MESSAGE, sessionService } from './session.service.js';
import { isLoggedIn } from './auth.service.js';
import { httpService } from './http.service.js';
import { sfccError } from '../spec/extract.js';

/**
 * Helpers for the tools that chain several carrefour.it calls in code
 * (checkout, shopping lists), where one-request JSON definitions fall short.
 */

export type Json = Record<string, unknown>;

/** A failure worth showing the user as is. */
export class SfccError extends Error {}

const XHR = { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' };

async function send(
  method: 'GET' | 'POST',
  url: string,
  opts: { form?: Record<string, string>; urlencoded?: Record<string, string>; query?: Record<string, string> }
): Promise<{ target: URL; data: unknown }> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) target.searchParams.set(k, v);
  const headers: Record<string, string> = { ...XHR };
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

/** One SFCC call answering a page or fragment of HTML. */
export async function sfccHtml(
  method: 'GET' | 'POST',
  url: string,
  opts: { urlencoded?: Record<string, string>; query?: Record<string, string> } = {}
): Promise<string> {
  const { data } = await send(method, url, opts);
  return typeof data === 'string' ? data : JSON.stringify(data);
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
