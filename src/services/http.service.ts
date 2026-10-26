import type { BuiltRequest } from '../spec/types.js';
import { browserService, type FetchRequest } from './browser.service.js';
import { logger } from '../utils/logger.js';

const RATE_LIMIT_REQUESTS = parseInt(process.env.RATE_LIMIT_REQUESTS || '10', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_MS || '100', 10);
const MAX_DELAY_MS = parseInt(process.env.MAX_DELAY_MS || '500', 10);

/** CSRF tokens travel in the query string of some calls; keep them out of the logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]csrf_token=)[^&]*/g, '$1<redacted>');
}

export interface HttpResult {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  contentType: string | null;
  data: unknown;
}

class HttpService {
  private requestTimestamps: number[] = [];
  private lastRequestTime = 0;

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Simple sliding-window limiter plus a small jitter between calls. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);

    if (this.requestTimestamps.length >= RATE_LIMIT_REQUESTS) {
      const wait = RATE_LIMIT_WINDOW_MS - (now - this.requestTimestamps[0]);
      if (wait > 0) {
        logger.info('Rate limit reached, waiting', { waitMs: wait });
        await this.sleep(wait);
      }
    }

    const sinceLast = Date.now() - this.lastRequestTime;
    const jitter = MIN_DELAY_MS + Math.random() * Math.max(0, MAX_DELAY_MS - MIN_DELAY_MS);
    if (sinceLast < jitter) await this.sleep(jitter - sinceLast);

    this.requestTimestamps.push(Date.now());
    this.lastRequestTime = Date.now();
  }

  /**
   * Send a request through the browser. There is nothing to renew on
   * carrefour.it — an expired SFCC session quietly turns into a guest one — so
   * this is a single attempt; callers that care check the login state first.
   */
  async send(request: BuiltRequest, opts: { withAuth: boolean } = { withAuth: true }): Promise<HttpResult> {
    return this.execute(request, opts.withAuth);
  }

  private async execute(request: BuiltRequest, withAuth: boolean): Promise<HttpResult> {
    await this.throttle();

    // The browser owns the cookies, the User-Agent and the Referer/Origin pair:
    // overriding them here would only contradict the page the request is sent
    // from, and `fetch` refuses to set them anyway.
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      ...request.headers,
    };

    const call: FetchRequest = { method: request.method, url: request.url, headers };
    if (typeof request.body === 'string') {
      call.body = request.body;
    } else if (request.body instanceof FormData) {
      // FormData cannot cross into the page; rebuild it there from its entries.
      call.formEntries = [...request.body.entries()].map(([key, value]) => [key, String(value)]);
    }

    logger.info('HTTP request', { method: request.method, url: redactUrl(request.url), withAuth });

    const response = await browserService.fetch(call);

    let data: unknown = response.text;
    if (response.contentType?.includes('json')) {
      try {
        data = JSON.parse(response.text);
      } catch {
        data = response.text;
      }
    }

    logger.info('HTTP response', { status: response.status, url: redactUrl(request.url) });

    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      url: response.url || request.url,
      contentType: response.contentType,
      data,
    };
  }
}

export const httpService = new HttpService();
