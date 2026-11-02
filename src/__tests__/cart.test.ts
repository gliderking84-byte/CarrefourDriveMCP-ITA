import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchRequest, FetchResponse } from '../services/browser.service.js';

// get_cart and remove_unavailable_products through a real MCP client, with carrefour.it scripted.
// The markup and JSON are trimmed, synthetic copies of the captured minicart and Cart-EmptyCartOutOfStock answers.

const dir = mkdtempSync(join(tmpdir(), 'carrefour-cart-test-'));
process.env.CARREFOUR_SESSION_FILE = join(dir, 'cookies.json');
process.env.CARREFOUR_DATA_DIR = dir;
process.env.MIN_DELAY_MS = '0';
process.env.MAX_DELAY_MS = '0';
process.env.RATE_LIMIT_REQUESTS = '1000';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { registerCartTools, parseDeliverySelection } = await import('../tools/cart.tools.js');
const { extractCart } = await import('../spec/extract.js');
const { check } = await import('../services/sfcc.service.js');
const { browserService } = await import('../services/browser.service.js');
const { sessionService } = await import('../services/session.service.js');
const { forgetLoginState } = await import('../services/auth.service.js');

const q = (value: unknown) => JSON.stringify(value).replace(/"/g, '&quot;');

const MINICART = `
  <div class="minicart-sidebar-substitution substitution-carousel toggler-card">
    <p class="semi-bold"><span class="title-small">1 Prodotto non disponibile</span></p>
    <button type="button" class="delete-all" data-component="deleteCartOutOfStockComponent"
      data-option-endpoint="/on/demandware.store/Sites-carrefour-IT-Site/it_IT/Cart-EmptyCartOutOfStock?csrf_token=X&amp;noredirect=true&amp;preserveMinicart=true">Elimina tutti</button>
    <div class="swiper-slide"><div class="line-item-card item-unavailable">
      <div class="card" data-product-json="${q({ name: 'Uova Fresche 6 pz', id: '8000000000111', price: '', brand: 'Marca Uova' })}"
        data-option-product-price="${q({ sales: null, list: null })}" data-product-quantity="2">
        <a class="product-link" href="/p/uova-fresche/8000000000111.html"><p class="product-name">Uova Fresche 6 pz</p></a>
        <button class="btn btn-link delete-btn" data-option-endpoint="/cart/remove-product?pid=8000000000111&amp;uuid=u1"></button>
      </div>
    </div></div>
  </div>
  <p class="address"><span class="cart-address-service">Ritiro in negozio</span></p>
  <div class="line-item-card-wrapper"><ul>
    <li class="line-item-card uuid-a pid-8000000000222" data-option-quantity="3">
      <div data-product-json="${q({ id: '8000000000222', name: 'Pasta 500 g', price: '0.99' })}"></div>
    </li>
  </ul></div>
  <p>Totale PRODOTTI</p>
  <p class="minicartsidebar-price">€ 2,97</p>`;

const SELECTED = {
  error: false,
  minutesBeforeTimeslotExpiry: 44,
  timeslotReserved: 'Domani, 18:00 - 20:00',
  shippingMethodIdSelected: 'pickup_in_store',
  storeIdSelected: '0001',
  shippingSelectedCAP: '10100',
};
const NOT_SELECTED = { error: false, shippingMethodIdSelected: null, storeIdSelected: '0002', shippingSelectedCAP: null };

const REMOVED = {
  action: 'Cart-EmptyCartOutOfStock',
  queryString: 'csrf_token=TOKEN&noredirect=true',
  success: true,
  numItems: 3,
  totals: { subTotal: '€ 2,97', grandTotal: '€ 3,21' },
  removedProducts: [
    {
      uuid: 'u1',
      id: '8000000000111',
      productName: 'Uova Fresche 6 pz',
      brand: 'Marca Uova',
      qtyincart: '2',
      availability: { messages: ["L'articolo non è al momento disponibile"] },
      available: false,
    },
  ],
};

const calls: FetchRequest[] = [];
let selection: unknown = SELECTED;
let respond: (req: FetchRequest) => { type?: string; body: unknown };
const originalFetch = browserService.fetch.bind(browserService);

function happy(req: FetchRequest): { type?: string; body: unknown } {
  const path = new URL(req.url).pathname;
  if (path.endsWith('Store-SelectionBar')) return { body: { storeSelectionBar: '<div data-option-user-logged="true"></div>' } };
  if (path.endsWith('CSRF-Generate')) return { body: { csrf: { token: 'TOKEN' } } };
  if (path.endsWith('Minicart-Show')) return { type: 'text/html', body: MINICART };
  if (path.endsWith('Store-ShowTimeslotReserved')) return { body: selection };
  if (path.endsWith('Cart-EmptyCartOutOfStock')) return { body: REMOVED };
  return { body: {} };
}

before(() => {
  browserService.fetch = async (req: FetchRequest): Promise<FetchResponse> => {
    calls.push(req);
    const { type, body } = respond(req);
    return {
      status: 200,
      statusText: 'OK',
      ok: true,
      url: req.url,
      contentType: type ?? 'application/json',
      text: typeof body === 'string' ? body : JSON.stringify(body),
    };
  };
});

after(() => {
  browserService.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  respond = happy;
  selection = SELECTED;
  forgetLoginState();
  sessionService.clear();
  sessionService.importCookies('dwsid=abc');
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const server = new McpServer({ name: 'test', version: '0' });
  registerCartTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const result = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, text: result.content[0].text };
}

const path = (req: FetchRequest) => new URL(req.url).pathname.split('/').pop();

test('extractCart keeps unavailable products apart from the cart lines', () => {
  const cart = extractCart(MINICART);
  assert.deepEqual(cart.items.map((i) => [i.ean, i.quantity_in_cart]), [['8000000000222', 3]]);
  assert.equal(cart.item_count, 3);
  assert.deepEqual(cart.unavailable_items, [
    {
      ean: '8000000000111',
      name: 'Uova Fresche 6 pz',
      brand: 'Marca Uova',
      quantity: 2,
      url: 'https://www.carrefour.it/p/uova-fresche/8000000000111.html',
    },
  ]);
  assert.match(cart.notices.join(' '), /1 product\(s\) not available.*remove_unavailable_products/);
});

test('extractCart without unavailable products has no unavailable_items', () => {
  const cart = extractCart(MINICART.slice(MINICART.indexOf('<p class="address">')));
  assert.equal(cart.unavailable_items, undefined);
  assert.deepEqual(cart.notices, []);
});

test('parseDeliverySelection flags a missing CAP or service, then a missing timeslot', () => {
  assert.deepEqual(parseDeliverySelection(SELECTED), {
    method: 'pickup_in_store',
    store_id: '0001',
    cap: '10100',
    timeslot: 'Domani, 18:00 - 20:00',
    minutes_left: 44,
  });
  const none = parseDeliverySelection(NOT_SELECTED);
  assert.equal(none.store_id, undefined, 'the default store is not a choice');
  assert.match(none.missing!, /No service and CAP are set.*find_stores/);
  const noSlot = parseDeliverySelection({ shippingMethodIdSelected: 'delivery', shippingSelectedCAP: '20121' });
  assert.match(noSlot.missing!, /No timeslot is reserved/);
});

test('get_cart joins the cart and the delivery selection', async () => {
  const result = await run('get_cart');
  assert.equal(result.isError, false, result.text);
  const cart = JSON.parse(result.text);
  assert.equal(cart.unavailable_items.length, 1);
  assert.equal(cart.delivery.cap, '10100');
  assert.equal(cart.delivery.missing, undefined);
});

test('get_cart says when no CAP or service is set', async () => {
  selection = NOT_SELECTED;
  const cart = JSON.parse((await run('get_cart')).text);
  assert.match(cart.delivery.missing, /No service and CAP are set/);
  assert.ok(cart.notices.some((n: string) => /Ask the user for their CAP/.test(n)));
});

test('remove_unavailable_products posts with the CSRF token in the query and lists what went', async () => {
  const result = await run('remove_unavailable_products');
  assert.equal(result.isError, false, result.text);
  const post = calls.find((c) => path(c) === 'Cart-EmptyCartOutOfStock')!;
  assert.equal(post.method, 'POST');
  const params = new URL(post.url).searchParams;
  assert.equal(params.get('csrf_token'), 'TOKEN');
  assert.equal(params.get('noredirect'), 'true');
  assert.deepEqual(JSON.parse(result.text), {
    removed_count: 1,
    removed: [
      {
        ean: '8000000000111',
        name: 'Uova Fresche 6 pz',
        brand: 'Marca Uova',
        quantity: 2,
        reason: "L'articolo non è al momento disponibile",
      },
    ],
    cart_items: 3,
    products_total: '€ 2,97',
    grand_total: '€ 3,21',
  });
  assert.equal(result.text.includes('TOKEN'), false);
});

test('remove_unavailable_products with nothing to remove says so', async () => {
  respond = (req) =>
    path(req) === 'Cart-EmptyCartOutOfStock' ? { body: { success: true, numItems: 3, removedProducts: [] } } : happy(req);
  const result = await run('remove_unavailable_products');
  assert.equal(result.isError, false);
  assert.match(result.text, /nothing removed/);
});

test('NO_SHIPPING_METHOD_SELECTED from any chained call explains how to set the CAP', () => {
  assert.throws(() => check('Add to cart', { error: 'NO_SHIPPING_METHOD_SELECTED' }), /Ask the user for their CAP/);
});
