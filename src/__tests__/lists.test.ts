import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchRequest, FetchResponse } from '../services/browser.service.js';

// Shopping lists and bulk cart tools through a real MCP client, with carrefour.it scripted.

const dir = mkdtempSync(join(tmpdir(), 'carrefour-lists-test-'));
process.env.CARREFOUR_SESSION_FILE = join(dir, 'cookies.json');
process.env.CARREFOUR_DATA_DIR = dir;
process.env.MIN_DELAY_MS = '0';
process.env.MAX_DELAY_MS = '0';
process.env.RATE_LIMIT_REQUESTS = '1000';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { registerListTools, parseShoppingLists, parseShoppingListProducts } = await import('../tools/lists.tools.js');
const { browserService } = await import('../services/browser.service.js');
const { sessionService } = await import('../services/session.service.js');
const { forgetLoginState } = await import('../services/auth.service.js');

const q = (value: unknown) => JSON.stringify(value).replace(/"/g, '&quot;');
const tile = (ean: string) =>
  `<article class="product tile" data-pid="${ean}" data-product-json="${q({ id: ean, name: `Prodotto ${ean}`, price: '1.00' })}"></article>`;

const LISTS_PAGE = `
  <a href="/wishlist?rurl=8&amp;id=aaa111&amp;listNum=1" class="list-link">Preferiti <span>(2)</span></a>
  <a href="/wishlist?rurl=8&amp;id=bbb222&amp;listNum=2">Spesa settimanale</a>
  <a href="/wishlist?rurl=8&amp;id=aaa111">Vedi lista</a>`;

const calls: FetchRequest[] = [];
let respond: (req: FetchRequest) => { type?: string; body: unknown };
let cartAfterEmpty = '';
const originalFetch = browserService.fetch.bind(browserService);

function happy(req: FetchRequest): { type?: string; body: unknown } {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path.endsWith('Store-SelectionBar')) return { body: { storeSelectionBar: '<div data-option-user-logged="true"></div>' } };
  if (path.endsWith('CSRF-Generate')) return { body: { csrf: { token: 'TOKEN' } } };
  if (path === '/account/wishlist') return { type: 'text/html', body: LISTS_PAGE };
  if (path === '/wishlist') return { type: 'text/html', body: url.searchParams.get('id') === 'aaa111' ? tile('111') + tile('222') : '<p>Lista vuota</p>' };
  if (path === '/cart/add-product') return { body: { quantityTotal: 2, totalPrice: '€ 2,00', message: 'Prodotto aggiunto al carrello', error: null } };
  if (path.endsWith('Cart-EmptyCart')) return { type: 'text/html', body: '<html>ok</html>' };
  if (path.endsWith('Minicart-Show')) return { type: 'text/html', body: cartAfterEmpty };
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
  cartAfterEmpty = '<h2>Il tuo carrello</h2>';
  forgetLoginState();
  sessionService.clear();
  sessionService.importCookies('dwsid=abc');
});

async function client() {
  const server = new McpServer({ name: 'test', version: '0' });
  registerListTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

async function run(name: string, args: Record<string, unknown> = {}) {
  const c = await client();
  const result = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, text: result.content[0].text };
}

const path = (req: FetchRequest) => new URL(req.url).pathname;
const form = (req: FetchRequest) => Object.fromEntries(req.formEntries ?? []);

test('parseShoppingLists keeps one entry per list, named by its first link', () => {
  assert.deepEqual(parseShoppingLists(LISTS_PAGE), [
    { list_id: 'aaa111', name: 'Preferiti', count: 2 },
    { list_id: 'bbb222', name: 'Spesa settimanale' },
  ]);
});

test('parseShoppingLists names "Vedi la lista" cards by their title', () => {
  const cards = `
    <div class="card"><p class="list-title">La mia lista spesa online (3)</p>
      <p>Ritrova i tuoi prodotti preferiti e aggiungili al carrello</p>
      <a href="/wishlist?rurl=8&amp;id=ab72">Vedi la lista</a></div>
    <div class="card"><h3>Lista Spesa (0)</h3><button>⋮</button>
      <a href="/wishlist?rurl=8&amp;id=3d04">Vedi la lista</a></div>
    <div class="card"><h3>nuova lista MPC (1)</h3>
      <a href="/wishlist?rurl=8&amp;id=f321">Vedi la lista</a></div>`;
  assert.deepEqual(parseShoppingLists(cards), [
    { list_id: 'ab72', name: 'La mia lista spesa online', count: 3 },
    { list_id: '3d04', name: 'Lista Spesa', count: 0 },
    { list_id: 'f321', name: 'nuova lista MPC', count: 1 },
  ]);
});

test('redactTokens hides the CSRF tokens a page embeds', async () => {
  const { redactTokens } = await import('../services/sfcc.service.js');
  const page = '<input name="csrf_token" type="hidden" value="SECRET1"/><input value="SECRET2" name="csrf_token">' +
    '<div data-option-token-value="SECRET3"></div><a href="/x?csrf_token=SECRET4&a=1">';
  assert.equal(/SECRET/.test(redactTokens(page)), false);
});

test('parseShoppingListProducts reads tiles, or any element carrying data-pid', () => {
  assert.deepEqual(parseShoppingListProducts(tile('111') + tile('222')).map((p) => p.ean), ['111', '222']);
  const loose = `<div class="wishlist-item" data-pid="333" data-product-json="${q({ id: '333', name: 'X' })}"></div>
                 <div class="wishlist-item" data-pid="333"></div><li data-pid="444"></li>`;
  assert.deepEqual(parseShoppingListProducts(loose).map((p) => p.ean), ['333', '444']);
});

test('add_shopping_list_to_cart sends the whole list in one pidsObj call', async () => {
  const res = await run('add_shopping_list_to_cart', { list_id: 'aaa111' });
  assert.equal(res.isError, false, res.text);
  const add = calls.find((r) => path(r) === '/cart/add-product')!;
  const f = form(add);
  assert.deepEqual(JSON.parse(f.pidsObj), [
    { pid: '111', qty: 1, addevenifunavailable: false, iswishlistaddall: true },
    { pid: '222', qty: 1, addevenifunavailable: false, iswishlistaddall: true },
  ]);
  assert.equal(f.skipnotifications, 'true');
  assert.equal(f.csrf_token, 'TOKEN');
  assert.match(res.text, /"added": 2/);
});

test('add_shopping_list_to_cart adds nothing when the list reads empty', async () => {
  const res = await run('add_shopping_list_to_cart', { list_id: 'bbb222' });
  assert.equal(res.isError, true);
  assert.equal(calls.some((r) => path(r) === '/cart/add-product'), false);
});

test('add_products_to_cart carries each quantity', async () => {
  const res = await run('add_products_to_cart', { products: [{ ean: '1', quantity: 3 }, { ean: '2' }] });
  assert.equal(res.isError, false, res.text);
  const pids = JSON.parse(form(calls.find((r) => path(r) === '/cart/add-product')!).pidsObj);
  assert.deepEqual(pids.map((p: { pid: string; qty: number }) => [p.pid, p.qty]), [['1', 3], ['2', 1]]);
});

test('empty_cart needs confirm, posts the form, and checks the cart is empty', async () => {
  assert.equal((await run('empty_cart', { confirm: false })).isError, true);
  assert.equal(calls.some((r) => path(r).endsWith('Cart-EmptyCart')), false);

  const res = await run('empty_cart', { confirm: true });
  assert.equal(res.isError, false, res.text);
  const post = calls.find((r) => path(r).endsWith('Cart-EmptyCart'))!;
  assert.equal(new URL(post.url).searchParams.get('noredirect'), 'true');
  assert.equal(post.body, 'csrf_token=TOKEN');
  assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('empty_cart reports a cart that is still full', async () => {
  cartAfterEmpty = `<li class="line-item-card uuid-x pid-1"><div data-product-json="${q({ id: '1', name: 'X' })}"></div></li>`;
  const res = await run('empty_cart', { confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /still holds/);
});
