import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchRequest, FetchResponse } from '../services/browser.service.js';

// The executor end to end, with the browser replaced by a script of responses.

const dir = mkdtempSync(join(tmpdir(), 'carrefour-register-test-'));
process.env.CARREFOUR_SESSION_FILE = join(dir, 'cookies.json');
process.env.MIN_DELAY_MS = '0';
process.env.MAX_DELAY_MS = '0';
process.env.RATE_LIMIT_REQUESTS = '1000';

const { executeSpec } = await import('../spec/register.js');
const { loadToolSpecs } = await import('../spec/loader.js');
const { browserService } = await import('../services/browser.service.js');
const { sessionService } = await import('../services/session.service.js');
const { forgetLoginState } = await import('../services/auth.service.js');

const specs = new Map(loadToolSpecs().specs.map((s) => [s.name, s]));
const calls: FetchRequest[] = [];
let respond: (req: FetchRequest) => Partial<FetchResponse>;
const originalFetch = browserService.fetch.bind(browserService);

function json(body: unknown): Partial<FetchResponse> {
  return { status: 200, ok: true, contentType: 'application/json', text: JSON.stringify(body) };
}

before(() => {
  browserService.fetch = async (req: FetchRequest) => {
    calls.push(req);
    return { status: 200, statusText: 'OK', ok: true, url: req.url, contentType: 'application/json', text: '{}', ...respond(req) };
  };
});

after(() => {
  browserService.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  forgetLoginState();
  sessionService.clear();
});

const selectionBar = (logged: boolean) =>
  json({ storeSelectionBar: `<div data-option-user-logged="${logged}"></div>` });

test('a write checks the login, fetches a CSRF token, sends it, and keeps it out of the answer', async () => {
  sessionService.importCookies('dwsid=abc');
  respond = (req) => {
    if (req.url.includes('Store-SelectionBar')) return selectionBar(true);
    if (req.url.includes('CSRF-Generate')) return json({ action: 'CSRF-Generate', csrf: { tokenName: 'csrf_token', token: 'TOKEN123' } });
    return json({
      action: 'Cart-AddProduct',
      queryString: 'csrf_token=TOKEN123',
      quantityTotal: 1,
      totalPrice: '€ 1,19',
      message: 'Prodotto aggiunto al carrello',
      error: null,
      pushPromoPre: [{ id: 'popup' }],
    });
  };

  const result = await executeSpec(specs.get('add_to_cart')!, { ean: '8002580010945' });

  assert.equal(result.isError, false);
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname.split('/').pop()),
    ['Store-SelectionBar', 'CSRF-Generate', 'add-product']
  );
  const form = Object.fromEntries(calls[2].formEntries ?? []);
  assert.equal(form.csrf_token, 'TOKEN123');
  assert.equal(form.quantity, '1');

  const text = result.content[0].text;
  assert.equal(text.includes('TOKEN123'), false);
  assert.deepEqual(JSON.parse(text), {
    quantityTotal: 1,
    totalPrice: '€ 1,19',
    message: 'Prodotto aggiunto al carrello',
    error: null,
  });
});

test('a write is not sent when carrefour.it treats the session as a guest', async () => {
  sessionService.importCookies('dwsid=abc');
  respond = (req) => (req.url.includes('Store-SelectionBar') ? selectionBar(false) : json({}));

  const result = await executeSpec(specs.get('add_to_cart')!, { ean: '1' });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no longer sees you as signed in/);
  assert.equal(calls.length, 1, 'neither CSRF-Generate nor the write may go out');
});

test('an authenticated read is refused too when the session has turned into a guest one', async () => {
  sessionService.importCookies('dwsid=abc');
  respond = (req) => (req.url.includes('Store-SelectionBar') ? selectionBar(false) : json({}));
  const result = await executeSpec(specs.get('get_cart')!, {});
  assert.equal(result.isError, true);
  assert.equal(calls.length, 1, 'the guest cart must not be fetched');
});

test('an authenticated tool without any stored session never touches the network', async () => {
  respond = () => json({});
  const result = await executeSpec(specs.get('get_cart')!, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No Carrefour session available/);
  assert.equal(calls.length, 0);
});

test('a public read goes straight out and comes back extracted', async () => {
  respond = () => json({
    action: 'SearchRouter-Suggestions',
    success: true,
    result: '<ul class="search-results-category"><li><a href="/spesa-online/latte/">Latte</a></li></ul>',
  });

  const result = await executeSpec(specs.get('search_suggestions')!, { q: 'latte' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/SearchRouter-Suggestions?q=latte'), true);
  assert.deepEqual(JSON.parse(result.content[0].text).categories, [
    { name: 'Latte', url: 'https://www.carrefour.it/spesa-online/latte/' },
  ]);
});
