import { createRequire } from 'module';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { existsSync, mkdirSync } from 'fs';
import { join, win32 } from 'path';
import { sessionService, CARREFOUR_ORIGIN } from './session.service.js';
import { browserService } from './browser.service.js';
import { forgetLoginState, isLoggedIn } from './auth.service.js';
import { logger } from '../utils/logger.js';
import { dataPath } from '../utils/paths.js';

const require = createRequire(import.meta.url);

export interface LoginBrowser {
  path: string;
  label: string;
}

/**
 * Where to look for a real, user-installed browser, by platform. Cloudflare
 * Turnstile is slow and keeps expiring in Playwright's "Chrome for Testing",
 * while it validates normally in a stock Chrome or Edge.
 */
export function loginBrowserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): LoginBrowser[] {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const under = (rel: string, label: string) => roots.map((root) => ({ path: win32.join(root, rel), label }));
    return [
      ...under('Google\\Chrome\\Application\\chrome.exe', 'Google Chrome'),
      ...under('Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge'),
      ...under('BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Brave'),
    ];
  }
  if (platform === 'darwin') {
    return [
      { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', label: 'Google Chrome' },
      { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', label: 'Microsoft Edge' },
      { path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', label: 'Brave' },
      { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', label: 'Chromium' },
    ];
  }
  return [
    { path: '/usr/bin/google-chrome', label: 'Google Chrome' },
    { path: '/usr/bin/google-chrome-stable', label: 'Google Chrome' },
    { path: '/usr/bin/microsoft-edge', label: 'Microsoft Edge' },
    { path: '/usr/bin/brave-browser', label: 'Brave' },
    { path: '/usr/bin/chromium', label: 'Chromium' },
    { path: '/usr/bin/chromium-browser', label: 'Chromium' },
    { path: '/snap/bin/chromium', label: 'Chromium' },
  ];
}

/**
 * The browser the login window runs in: CARREFOUR_LOGIN_BROWSER if set, else
 * the first installed Chrome-family browser, else Playwright's Chromium.
 */
export function findLoginBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): LoginBrowser | null {
  if (env.CARREFOUR_LOGIN_BROWSER) return { path: env.CARREFOUR_LOGIN_BROWSER, label: 'CARREFOUR_LOGIN_BROWSER' };
  return loginBrowserCandidates(platform, env).find((b) => exists(b.path)) ?? null;
}

function playwrightChromium(): LoginBrowser {
  const { chromium } = require('playwright') as typeof import('playwright');
  return { path: chromium.executablePath(), label: 'Chrome for Testing (Playwright)' };
}

export function isPlaywrightAvailable(): boolean {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

/**
 * The login form for private customers. Plain `/login` first asks to choose
 * between private and business accounts (`/login/selezione`); `type=b2c` skips
 * that step. A successful sign-in redirects away from `/login` (to `/account`).
 */
const LOGIN_URL = `${CARREFOUR_ORIGIN}/login?type=b2c`;
const POLL_MS = 2000;

export interface BrowserLoginOptions {
  waitMs?: number;
  browser?: LoginBrowser;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * The DevTools *HTTP* endpoint. Unlike a CDP WebSocket session it does not
 * enable any domain in the page, so polling it does not make the browser look
 * automated — which matters, because Turnstile refuses to validate as soon as
 * something is really attached.
 */
async function openTabs(port: number): Promise<Array<{ type: string; url: string }>> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await response.json()) as Array<{ type: string; url: string }>;
}

function loggedIn(tabs: Array<{ type: string; url: string }>): boolean {
  return tabs.some((tab) => {
    if (tab.type !== 'page') return false;
    try {
      const url = new URL(tab.url);
      // Account-Login answers with a redirect URL; leaving /login means it succeeded.
      return url.origin === CARREFOUR_ORIGIN && !url.pathname.startsWith('/login');
    } catch {
      return false;
    }
  });
}

/**
 * Sign in through a browser window the user drives themselves.
 *
 * Two constraints shape this:
 *
 *  - Cloudflare Turnstile refuses to validate in a CDP-driven browser, so the
 *    window cannot be a Playwright one. It is a plain browser process — the
 *    user's own Chrome or Edge when installed — with a debugging port opened
 *    but nothing attached to it until the login is done.
 *  - the SFCC session cookies are *session* cookies, and Chromium never writes
 *    those to disk. Waiting for the window to close would therefore destroy
 *    exactly what we came for, and the on-disk cookies are encrypted with a key
 *    that another Chromium launch may not be able to read anyway.
 *
 * So we watch the tab list over plain HTTP, and the moment the window leaves the
 * login page we attach, lift the cookies out of the live browser and keep them
 * in the jar — which is what seeds the server's own browser profile on every
 * launch.
 */
export async function browserLogin(opts: BrowserLoginOptions = {}): Promise<string> {
  if (!isPlaywrightAvailable()) {
    throw new Error(
      'Playwright is not installed. Run `npm install playwright && npx playwright install chromium`.'
    );
  }

  const { chromium } = await import('playwright');
  const browser = opts.browser ?? findLoginBrowser() ?? playwrightChromium();
  const executable = browser.path;
  const port = await freePort();
  // A dedicated profile, kept between logins: Cloudflare is far quicker with a
  // browser it has seen before than with a blank one. Never the user's own
  // profile (Chrome refuses remote debugging on it), never the server's.
  const dir = dataPath('login-profile');
  mkdirSync(dir, { recursive: true });
  const waitMs = opts.waitMs ?? 900_000;
  logger.info('Opening the login window', { browser: browser.label, executable });

  const child = spawn(
    executable,
    [
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      LOGIN_URL,
    ],
    { stdio: 'ignore', detached: true }
  );
  child.unref();
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  // Without a listener, a failed spawn (missing executable) would crash the whole server.
  child.once('error', (error) => {
    exited = true;
    logger.error('Could not start the login browser', { executable, error: String(error) });
  });

  let signedIn = false;
  const deadline = Date.now() + waitMs;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      // The window was closed, or Chromium could not start (no display, missing libraries).
      if (exited) break;
      let tabs;
      try {
        tabs = await openTabs(port);
      } catch {
        // Not up yet, or the user closed the window.
        continue;
      }
      if (tabs.length === 0) break;
      if (loggedIn(tabs)) {
        signedIn = true;
        break;
      }
    }

    if (!signedIn) {
      return (
        'The login did not complete: the window was closed, or never left the login page. Run the tool ' +
        'again, and leave the window open once you are signed in — closing it discards the session.'
      );
    }

    // Only now do we attach: the captcha is behind us.
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const cookies = (await Promise.all(browser.contexts().map((context) => context.cookies()))).flat();
      sessionService.importCookies(JSON.stringify(cookies));
      logger.info('Login cookies collected', { count: cookies.length });
    } finally {
      await browser.close().catch(() => undefined);
    }
  } finally {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }

  // Hand the fresh cookies to the server's browser, and prove they work.
  await browserService.close();
  forgetLoginState();
  let logged: boolean | null = null;
  try {
    logged = await isLoggedIn({ fresh: true });
  } catch (error) {
    logger.error('Could not verify the login', { error: String(error) });
  }
  if (logged === false) {
    return (
      'The window left the login page, but carrefour.it treats the session as a guest. Run the tool ' +
      'again and wait until the site shows you as signed in before doing anything else.'
    );
  }
  return (
    'Signed in. The session is stored and kept alive while the server runs; after a long idle ' +
    'period carrefour.it expires it and you will have to sign in again.'
  );
}

export interface LoginState {
  inProgress: boolean;
  startedAt?: Date;
  browser?: string;
  /** Outcome of the last login attempt, once it finished. */
  lastResult?: string;
}

let current: { startedAt: Date; browser: string; done: Promise<string> } | null = null;
let lastResult: string | undefined;

/**
 * Open the login window and watch it in the background. MCP clients give up on
 * a tool call long before a human is done with a captcha (MCP Inspector after
 * 60 s), so the tool must not hold the call open for the whole login. Calling
 * this again while a window is open returns the same attempt instead of a
 * second window.
 */
export function startBrowserLogin(opts: BrowserLoginOptions = {}): {
  alreadyRunning: boolean;
  startedAt: Date;
  browser: string;
  done: Promise<string>;
} {
  if (current) return { alreadyRunning: true, ...current };

  const startedAt = new Date();
  let browser: LoginBrowser | undefined = opts.browser;
  try {
    browser ??= findLoginBrowser() ?? playwrightChromium();
  } catch {
    // Playwright missing: browserLogin reports it.
  }
  const done = browserLogin({ ...opts, browser })
    .catch((error: unknown) => `Browser login failed: ${(error as Error).message}`)
    .then((result) => {
      lastResult = result;
      current = null;
      logger.info('Browser login finished', { result });
      return result;
    });
  current = { startedAt, browser: browser?.label ?? 'unknown', done };
  return { alreadyRunning: false, ...current };
}

export function loginState(): LoginState {
  return current
    ? { inProgress: true, startedAt: current.startedAt, browser: current.browser, lastResult }
    : { inProgress: false, lastResult };
}

/**
 * Open `url` for the user in a normal browser window — the payment page, which
 * a human has to go through (PayPal sign-in, hCaptcha, card 3-D Secure).
 *
 * It uses the login profile, which holds the carrefour.it session the server
 * was given at sign-in, so returning from the payment provider lands in the
 * same session. No debugging port: nothing about this window is automated.
 */
export function openInUserBrowser(url: string): { opened: boolean; browser: string; error?: string } {
  let browser: LoginBrowser;
  try {
    browser = findLoginBrowser() ?? playwrightChromium();
  } catch (error) {
    return { opened: false, browser: 'none', error: (error as Error).message };
  }
  const dir = dataPath('login-profile');
  mkdirSync(dir, { recursive: true });
  try {
    const child = spawn(browser.path, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', url], {
      stdio: 'ignore',
      detached: true,
    });
    child.once('error', (error) => logger.error('Could not open the payment page', { error: String(error) }));
    child.unref();
    return { opened: true, browser: browser.label };
  } catch (error) {
    return { opened: false, browser: browser.label, error: (error as Error).message };
  }
}
