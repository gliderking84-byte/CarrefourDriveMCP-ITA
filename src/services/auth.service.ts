import { SFCC_BASE, SessionService, sessionService } from './session.service.js';
import { browserService } from './browser.service.js';
import { logger } from '../utils/logger.js';

/**
 * Carrefour Italia authentication, as observed on the live site.
 *
 * carrefour.it is a Salesforce Commerce Cloud storefront: the whole session —
 * guest or signed in — lives in the SFCC session cookies on `www.carrefour.it`.
 * There is no separate identity provider and no refresh token. Signing in posts
 * to `Account-Login` with a Cloudflare Turnstile token, which only a human in a
 * real browser can produce, so the login itself is never scripted.
 *
 * What the server can do on its own:
 *   - fetch the CSRF token SFCC requires on every state-changing call;
 *   - tell a signed-in session from a guest one;
 *   - keep the session from idling out while the server runs.
 */

const CSRF_URL = `${SFCC_BASE}/CSRF-Generate`;
/** Cheap JSON endpoint whose markup says whether the customer is signed in. */
const LOGIN_PROBE_URL = `${SFCC_BASE}/Store-SelectionBar?pagetype=home&timeslotEnabled=true`;
/** Lightest authenticated read, used to keep the session alive. */
const KEEPALIVE_URL = `${SFCC_BASE}/Store-ShowTimeslotReserved`;

const XHR_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'x-requested-with': 'XMLHttpRequest',
};

/** Ask SFCC for a fresh CSRF token. Tokens are tied to the session, so one is fetched per write. */
export async function getCsrfToken(): Promise<string> {
  const response = await browserService.fetch({ method: 'POST', url: CSRF_URL, headers: XHR_HEADERS });
  if (!response.ok) throw new Error(`CSRF-Generate answered HTTP ${response.status}`);
  let token: unknown;
  try {
    token = (JSON.parse(response.text) as { csrf?: { token?: unknown } }).csrf?.token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || !token) throw new Error('CSRF-Generate returned no token');
  return token;
}

/** Read the signed-in flag out of a Store-SelectionBar response. `null` when it is not there. */
export function parseUserLogged(body: string): boolean | null {
  const match = body.match(/data-option-user-logged=\\?"(true|false)\\?"/);
  return match ? match[1] === 'true' : null;
}

const LOGIN_CACHE_MS = 5 * 60_000;
let loginCache: { at: number; logged: boolean | null } | null = null;

/**
 * Whether the browser session belongs to a signed-in customer. SFCC never
 * answers 401: an expired session silently becomes a guest one, and a write
 * would land in an anonymous cart. Cached briefly so writes do not double the
 * request count.
 */
export async function isLoggedIn(opts: { fresh?: boolean } = {}): Promise<boolean | null> {
  if (!opts.fresh && loginCache && Date.now() - loginCache.at < LOGIN_CACHE_MS) return loginCache.logged;
  const response = await browserService.fetch({ method: 'GET', url: LOGIN_PROBE_URL, headers: XHR_HEADERS });
  const logged = response.ok ? parseUserLogged(response.text) : null;
  loginCache = { at: Date.now(), logged };
  return logged;
}

export function forgetLoginState(): void {
  loginCache = null;
}

let keepAliveTimer: NodeJS.Timeout | null = null;

/**
 * SFCC drops idle sessions after about half an hour, which a long-running MCP
 * server would otherwise hit between two user requests. A light authenticated
 * read on a timer keeps it alive — only while the browser is already up, so an
 * idle server never launches Chromium just for this.
 *
 * Set CARREFOUR_KEEPALIVE_MINUTES=0 to opt out.
 */
export function startKeepAlive(session: SessionService = sessionService): void {
  const minutes = parseInt(process.env.CARREFOUR_KEEPALIVE_MINUTES || '20', 10);
  if (!Number.isFinite(minutes) || minutes <= 0 || keepAliveTimer) return;

  keepAliveTimer = setInterval(() => {
    if (!session.hasSession() || !browserService.isRunning()) return;
    browserService
      .fetch({ method: 'GET', url: KEEPALIVE_URL, headers: XHR_HEADERS })
      .then((response) => logger.info('Keep-alive', { status: response.status }))
      .catch((error) => logger.error('Keep-alive failed', { error: String(error) }));
  }, minutes * 60_000);

  // Never hold the process open just for the keep-alive.
  keepAliveTimer.unref?.();
}

export function stopKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}
