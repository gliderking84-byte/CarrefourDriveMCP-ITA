import { mkdirSync } from 'fs';
import { resolve } from 'path';
import type { BrowserContext, Page } from 'playwright';
import { sessionService } from './session.service.js';
import { logger } from '../utils/logger.js';
import { dataPath } from '../utils/paths.js';

/**
 * All Carrefour traffic goes through a real Chromium.
 *
 * Like carrefour.fr, carrefour.it sits behind Cloudflare (`server: cloudflare`,
 * `/cdn-cgi/rum`), whose managed challenge fingerprints the client: a Node
 * `fetch` is answered with `403 cf-mitigated: challenge`, while Chrome on the
 * same IP gets a clean `200`. No amount of header spoofing fixes that, so the
 * only viable transport is a browser, and the requests must be issued *inside a
 * page*: Playwright's own APIRequestContext uses a Node HTTP stack and is
 * challenged just like `fetch`.
 *
 * Measured on carrefour.fr on 2026-08-19, before the port to carrefour.it:
 *
 *   headless shell                                  -> 403 (UA says HeadlessChrome)
 *   channel 'chromium', headless                    -> 403 (idem)
 *   headed                                          -> 200
 *   channel 'chromium', headless + masked UA
 *     + --disable-blink-features=AutomationControlled -> 200
 *
 * The last line is what this service launches: no window, and it passes.
 */

/** A stock Chrome UA — the default one leaks `HeadlessChrome` and gets blocked. */
const USER_AGENT =
  process.env.CARREFOUR_USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = parseInt(process.env.CARREFOUR_NAV_TIMEOUT_MS || '60000', 10);

/**
 * Where to park a page per origin. The cart page is light, never redirects a
 * guest away, and is what the storefront's own XHRs are sent from.
 */
const PARKING_PATH: Record<string, string> = {
  'https://www.carrefour.it': '/cart',
};

function parkingUrl(origin: string): string {
  return `${origin}${PARKING_PATH[origin] ?? '/'}`;
}

export function profileDir(): string {
  return process.env.CARREFOUR_BROWSER_PROFILE
    ? resolve(process.env.CARREFOUR_BROWSER_PROFILE)
    : dataPath('browser-profile');
}

export interface FetchRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** multipart/form-data payloads, rebuilt as a FormData inside the page. */
  formEntries?: Array<[string, string]>;
}

export interface FetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  contentType: string | null;
  text: string;
}

class BrowserService {
  private context: BrowserContext | null = null;
  private headed = false;
  private starting: Promise<BrowserContext> | null = null;
  /** One parked page per origin: an in-page fetch is subject to CORS. */
  private pages = new Map<string, Page>();

  isRunning(): boolean {
    return this.context !== null;
  }

  private async launch(headless: boolean): Promise<BrowserContext> {
    const dir = profileDir();
    mkdirSync(dir, { recursive: true });

    // Imported at call time so the module graph stays loadable without playwright.
    const { chromium } = await import('playwright');

    const context = await chromium.launchPersistentContext(dir, {
      headless,
      // The full browser, not the headless shell: the shell is fingerprinted.
      channel: 'chromium',
      userAgent: USER_AGENT,
      args: ['--disable-blink-features=AutomationControlled'],
      locale: 'it-IT',
      timezoneId: 'Europe/Rome',
      viewport: { width: 1366, height: 900 },
    });
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    // Seed the profile with anything the user imported by hand or via the env.
    const seeded = sessionService.toPlaywrightCookies();
    if (seeded.length > 0) {
      await context.addCookies(seeded).catch((error) => {
        logger.error('Could not seed the browser with the stored cookies', { error: String(error) });
      });
    }

    this.headed = headless === false;
    logger.info('Browser started', { headless, profile: dir });
    return context;
  }

  /** The persistent profile can only be opened once, so launches are serialised. */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.starting) {
      this.starting = this.launch(true)
        .then((context) => {
          this.context = context;
          context.on('close', () => {
            this.context = null;
            this.pages.clear();
          });
          return context;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  /**
   * A page parked on `origin`, so that a fetch from it is same-origin.
   * Re-navigates when the site moved the page from under us.
   */
  private async pageFor(origin: string): Promise<Page> {
    const context = await this.ensureContext();
    const existing = this.pages.get(origin);
    if (existing && !existing.isClosed()) {
      if (new URL(existing.url()).origin === origin) return existing;
      await existing.goto(parkingUrl(origin), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      return existing;
    }

    const page = context.pages().find((p) => !p.isClosed() && !this.isParked(p)) ?? (await context.newPage());
    // A 404 is fine: all we need from the navigation is the origin.
    await page.goto(parkingUrl(origin), { waitUntil: 'domcontentloaded' }).catch((error) => {
      logger.error('Could not park a page on the origin', { origin, error: String(error) });
    });
    this.pages.set(origin, page);
    return page;
  }

  private isParked(page: Page): boolean {
    for (const parked of this.pages.values()) if (parked === page) return true;
    return false;
  }

  /** Issue one request from inside the page, i.e. through Chromium's own stack. */
  async fetch(request: FetchRequest): Promise<FetchResponse> {
    const origin = new URL(request.url).origin;

    const run = async (): Promise<FetchResponse> => {
      const page = await this.pageFor(origin);
      const result = await page.evaluate(async (req) => {
        let body: BodyInit | undefined = req.body;
        if (req.formEntries) {
          const form = new FormData();
          for (const [key, value] of req.formEntries) form.append(key, value);
          body = form;
        }
        const response = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body,
          credentials: 'include',
        });
        return {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          url: response.url,
          contentType: response.headers.get('content-type'),
          text: await response.text(),
        };
      }, request);
      return result as FetchResponse;
    };

    try {
      return await run();
    } catch (error) {
      // A navigation can tear down the execution context mid-call; re-park once.
      logger.info('In-page fetch failed, re-parking the page and retrying', {
        url: request.url,
        error: String(error),
      });
      const stale = this.pages.get(origin);
      if (stale && !stale.isClosed()) await stale.close().catch(() => undefined);
      this.pages.delete(origin);
      return run();
    }
  }

  /**
   * Navigate the parked page for this origin to `url` and leave it there, so
   * later in-page requests go out from that page (SFCC's checkout expects its
   * calls to come from /checkout/begin, which also sets the checkout up).
   */
  async visit(url: string): Promise<{ status: number | null; finalUrl: string }> {
    const page = await this.pageFor(new URL(url).origin);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { status: response?.status() ?? null, finalUrl: page.url() };
  }

  /**
   * The visible messages on the page parked for `origin` (e.g. the alerts on
   * /cart after the checkout bounced there), deduplicated, at most `max`.
   */
  async pageMessages(origin: string, selector: string, max = 5): Promise<string[]> {
    const page = this.pages.get(origin);
    if (!page || page.isClosed()) return [];
    try {
      return await page.evaluate(
        ({ selector, max }) => {
          const seen = new Set<string>();
          for (const el of Array.from(document.querySelectorAll(selector))) {
            const box = (el as HTMLElement).getBoundingClientRect();
            const text = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
            // quantity widgets and bare numbers are not messages ("Quantità 2")
            if (/^(quantit[aà]|qty|quantity)?\s*[:x×]?\s*\d+([.,]\d+)?\s*(pz|kg|g)?$/i.test(text)) continue;
            if (el.closest('input, select, button, option')) continue;
            if (text && box.width > 0 && box.height > 0 && text.length < 300) seen.add(text);
            if (seen.size >= max) break;
          }
          return [...seen];
        },
        { selector, max }
      );
    } catch {
      return [];
    }
  }

  /** The visible text of the page parked for `origin` ('' if there is none). */
  async pageText(origin: string): Promise<string> {
    const page = this.pages.get(origin);
    if (!page || page.isClosed()) return '';
    try {
      return await page.evaluate(() => (document.body ? document.body.innerText : '') || '');
    } catch {
      return '';
    }
  }

  /** HTML and a screenshot of the page parked for `origin` (for debugging a page we cannot read). */
  async pageSnapshot(origin: string): Promise<{ html: string; png: Buffer | null } | null> {
    const page = this.pages.get(origin);
    if (!page || page.isClosed()) return null;
    try {
      const html = await page.content();
      const png = await page.screenshot({ fullPage: true }).catch(() => null);
      return { html, png };
    } catch {
      return null;
    }
  }

  /**
   * Follow `url` in a throwaway tab of the signed-in browser until it lands on a
   * URL matching `until` (e.g. the PayPal page carrefour.it redirects to), and
   * return that URL. The parked pages are left alone. Throws on timeout.
   */
  async followRedirect(url: string, until: RegExp, timeoutMs = 20000): Promise<string> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs }).catch(() => undefined);
      if (!until.test(page.url())) await page.waitForURL(until, { timeout: timeoutMs, waitUntil: 'commit' });
      return page.url();
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * The card form as carrefour.it shows it: the order's payment page either leaves carrefour.it
   * (top level) or shows Market Pay's page in an iframe. Returns that exact URL (hash included,
   * which is what tells Market Pay which form to show) and how many card fields it renders, both
   * where carrefour.it shows it and opened on its own (as on a phone). Fields are counted, never
   * filled. url '' when no provider page shows up.
   */
  async cardPageFrom(url: string, provider: RegExp, timeoutMs = 25000): Promise<{ url: string; fields: number; standaloneFields: number }> {
    const context = await this.ensureContext();
    const deadline = Date.now() + timeoutMs;
    const CARD_FIELDS =
      'input[autocomplete="cc-number"], input[autocomplete="cc-exp"], input[autocomplete="cc-csc"], input[name*="card" i], input[id*="card" i], input[name*="pan" i], input[id*="pan" i], input[name*="cvv" i], input[id*="cvv" i], input[name*="cvc" i], input[id*="cvc" i], input[name*="numero" i], input[id*="numero" i]';
    // card fields in the page and in all its frames (the number field is often a nested iframe)
    const countFields = async (page: Page): Promise<number> => {
      let n = 0;
      for (const f of page.frames()) n += await f.locator(CARD_FIELDS).count().catch(() => 0);
      return n;
    };
    const settle = async (page: Page) => {
      await page.waitForLoadState('networkidle', { timeout: Math.min(8000, Math.max(1000, deadline - Date.now())) }).catch(() => undefined);
    };
    let found = '';
    let fields = 0;
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined);
      while (Date.now() < deadline && !found) {
        if (provider.test(page.url())) found = page.url();
        else found = page.frames().map((f) => f.url()).find((u) => provider.test(u)) ?? '';
        if (!found) await page.waitForTimeout(250);
      }
      if (found) {
        await settle(page);
        // the frame may have moved on (selection → card form): keep its latest URL
        const latest = provider.test(page.url()) ? page.url() : page.frames().map((f) => f.url()).find((u) => provider.test(u));
        if (latest) found = latest;
        fields = await countFields(page);
      }
    } finally {
      await page.close().catch(() => undefined);
    }
    if (!found) return { url: '', fields: 0, standaloneFields: 0 };
    let standaloneFields = 0;
    const alone = await context.newPage();
    try {
      await alone.goto(found, { waitUntil: 'domcontentloaded', timeout: Math.max(5000, deadline - Date.now()) }).catch(() => undefined);
      await settle(alone);
      standaloneFields = await countFields(alone);
    } finally {
      await alone.close().catch(() => undefined);
    }
    let shape = '';
    try {
      const u = new URL(found);
      shape = `${u.host}${u.pathname}${u.hash}`; // no session id in the logs
    } catch {
      /* ignore */
    }
    logger.info('Card payment page', { page: shape, fields, standaloneFields });
    return { url: found, fields, standaloneFields };
  }

  /**
   * From the payment provider's hosted page (Market Pay, `#pay=EWALLET_PAYPAL` preselects PayPal) to
   * PayPal's own page: press the provider's pay button in a throwaway tab and read where it lands
   * (same tab or a popup). PayPal's URL carries its own token, works on any device and, on a phone
   * with the PayPal app, can open the app. '' when the page has no such button or never reaches PayPal:
   * the caller keeps the provider's page. Nothing is ticked or filled in, only the pay button pressed.
   */
  async payPalFromProvider(url: string, paypal: RegExp, timeoutMs = 25000): Promise<string> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    const popups: Page[] = [];
    const onPage = (p: Page) => popups.push(p);
    context.on('page', onPage);
    // PayPal opens at the top (Market Pay sets window.top.location from its iframe) or in a popup
    const landed = (): string =>
      [page, ...popups].flatMap((p) => [p.url(), ...p.frames().map((f) => f.url())]).find((u) => paypal.test(u)) ?? '';
    const deadline = Date.now() + timeoutMs;
    const seen: string[] = [];
    let pressed = 0;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined);
      if (landed()) return landed();
      await page.waitForLoadState('networkidle', { timeout: Math.min(8000, Math.max(0, deadline - Date.now())) }).catch(() => undefined);
      // The buttons can sit in the page or in Market Pay's iframe (carrefour.it's page), and Market
      // Pay's page opened on its own shows "Paga" twice (one of them does nothing): every visible
      // match is tried, "Paga" first, each with a short wait.
      const label = /^\s*(paga|pay|procedi|prosegui|continua|conferma|confirm|continue|paypal)\b|paypal/i;
      const exact = /^\s*(paga|pay)\s*$/i;
      const found: { el: ReturnType<Page['locator']>; name: string }[] = [];
      for (const frame of page.frames()) {
        const candidates = frame.locator('button, input[type=submit], input[type=button], a[role=button], [role=button], [id*=paypal i], [class*=paypal i]');
        const count = Math.min(await candidates.count().catch(() => 0), 60);
        for (let i = 0; i < count; i++) {
          const el = candidates.nth(i);
          if (!(await el.isVisible().catch(() => false))) continue;
          const name = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || (await el.getAttribute('id').catch(() => '')) || '').trim();
          seen.push(name.slice(0, 30));
          if (label.test(name)) found.push({ el, name });
        }
      }
      found.sort((a, b) => Number(exact.test(b.name)) - Number(exact.test(a.name)));
      for (const { el } of found) {
        if (Date.now() >= deadline || landed()) break;
        pressed++;
        await el.click({ timeout: 4000 }).catch(() => undefined);
        const until = Math.min(deadline, Date.now() + 7000);
        while (Date.now() < until && !landed()) await page.waitForTimeout(250);
      }
      if (landed()) return landed();
      logger.info('PayPal not reached from the payment page', { pressed, buttons: seen.filter(Boolean).slice(0, 10) });
      return '';
    } finally {
      context.off('page', onPage);
      // the popup is closed too: the PayPal token lives at PayPal, not in this tab
      await Promise.all([page, ...popups].map((p) => p.close().catch(() => undefined)));
    }
  }


  /** Mirror the browser's cookies back into the jar so status/refresh can read them. */
  async syncCookies(): Promise<void> {
    try {
      const context = await this.ensureContext();
      const cookies = await context.cookies();
      if (cookies.length > 0) sessionService.importCookies(JSON.stringify(cookies));
    } catch (error) {
      logger.error('Could not read the browser cookies', { error: String(error) });
    }
  }

  /**
   * Run `work` in a visible browser. The persistent profile allows a single
   * instance, so the headless context is closed and reopened around it.
   */
  async withHeadedContext<T>(work: (context: BrowserContext) => Promise<T>): Promise<T> {
    await this.close();
    const context = await this.launch(false);
    try {
      return await work(context);
    } finally {
      await context.close().catch(() => undefined);
      this.headed = false;
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.pages.clear();
    if (context) await context.close().catch(() => undefined);
  }

  describe(): { running: boolean; headed: boolean; profile: string } {
    return { running: this.context !== null, headed: this.headed, profile: profileDir() };
  }
}

export const browserService = new BrowserService();
