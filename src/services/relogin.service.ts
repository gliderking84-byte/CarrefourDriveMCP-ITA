import { sessionService } from './session.service.js';
import { forgetLoginState, isLoggedIn } from './auth.service.js';
import { GOOGLE_LOGIN_URL, browserLogin } from './browser-login.js';
import { logger } from '../utils/logger.js';

/**
 * Unattended re-login through "Accedi con Google".
 *
 * Once a person has signed in to Google in the login profile, Google keeps that
 * session for weeks. When the carrefour.it session has expired, the server
 * opens the Google button's URL in that profile: Google answers without a
 * password or captcha, and the cookies are lifted exactly as after a manual
 * login. Nothing is typed and no password is stored; if Google wants the user
 * again (expired session, new-device check), the attempt simply fails and the
 * user signs in once by hand.
 *
 * Off unless CARREFOUR_GOOGLE_RELOGIN=1.
 */

const COOLDOWN_MS = 10 * 60_000;
const ATTEMPT_MS = parseInt(process.env.CARREFOUR_GOOGLE_RELOGIN_TIMEOUT_MS || '60000', 10);

export function googleReloginEnabled(): boolean {
  return process.env.CARREFOUR_GOOGLE_RELOGIN === '1';
}

/** The attempt itself; replaceable in tests. */
export const relogin = {
  /** Resolves to the login's outcome message. */
  async run(): Promise<string> {
    return browserLogin({
      startUrl: GOOGLE_LOGIN_URL,
      waitMs: ATTEMPT_MS,
      headless: process.env.CARREFOUR_GOOGLE_RELOGIN_HEADLESS === '1',
    });
  },
};

let inFlight: Promise<boolean> | null = null;
let lastFailure = 0;
let lastNote = '';

/**
 * Why the last Google re-login failed, for the tool that gave up: usually that
 * Google wants the user again, so they know to sign in once on the desk.
 */
export function lastReloginNote(): string {
  return lastNote;
}

/** Exposed for tests. */
export function resetRelogin(): void {
  inFlight = null;
  lastFailure = 0;
  lastNote = '';
}

/**
 * One Google re-login, shared by concurrent callers, and not retried for ten
 * minutes after a failure so a dead Google session is not hammered.
 */
export function tryGoogleRelogin(): Promise<boolean> {
  if (!googleReloginEnabled()) return Promise.resolve(false);
  if (inFlight) return inFlight;
  if (Date.now() - lastFailure < COOLDOWN_MS) return Promise.resolve(false);

  inFlight = (async () => {
    try {
      logger.info('carrefour.it session lost, signing in again with Google');
      const outcome = await relogin.run();
      forgetLoginState();
      const ok = (await isLoggedIn({ fresh: true })) === true;
      if (!ok) {
        lastFailure = Date.now();
        lastNote = `Signing in again with Google did not work: ${outcome} Google probably wants you again: sign in once with carrefour_browser_login method=google${process.env.CARREFOUR_DESK_URL ? ` on ${process.env.CARREFOUR_DESK_URL}` : ''}.`;
      } else {
        lastNote = '';
      }
      logger.info('Google re-login finished', { ok, outcome });
      return ok;
    } catch (error) {
      lastFailure = Date.now();
      lastNote = `Signing in again with Google failed: ${(error as Error).message}`;
      logger.error('Google re-login failed', { error: String(error) });
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Whether the session can act for a signed-in customer, re-logging in with
 * Google first when that is enabled and the session is missing or has turned
 * into a guest one. `none`: no session at all; `guest`: carrefour.it sees a
 * guest; `unknown`: the check itself was inconclusive.
 */
export async function ensureSignedIn(): Promise<'ok' | 'none' | 'guest' | 'unknown'> {
  if (!sessionService.hasSession()) {
    return (await tryGoogleRelogin()) ? 'ok' : 'none';
  }
  const logged = await isLoggedIn();
  if (logged === true) return 'ok';
  if (logged === null) return 'unknown';
  return (await tryGoogleRelogin()) ? 'ok' : 'guest';
}
