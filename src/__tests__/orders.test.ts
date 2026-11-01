import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchRequest, FetchResponse } from '../services/browser.service.js';

// Order history, status, details, receipt and reorder through a real MCP client, with carrefour.it scripted.
// Every value below is synthetic, shaped like the captured Order-HistoryOrders answer.

const dir = mkdtempSync(join(tmpdir(), 'carrefour-orders-test-'));
process.env.CARREFOUR_SESSION_FILE = join(dir, 'cookies.json');
process.env.CARREFOUR_DATA_DIR = dir;
process.env.MIN_DELAY_MS = '0';
process.env.MAX_DELAY_MS = '0';
process.env.RATE_LIMIT_REQUESTS = '1000';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { registerOrderTools, parseOrderHistory, parseOrderDetailProducts } = await import('../tools/orders.tools.js');
const { browserService } = await import('../services/browser.service.js');
const { sessionService } = await import('../services/session.service.js');
const { forgetLoginState } = await import('../services/auth.service.js');

const BASE = 'https://www.carrefour.it/on/demandware.store/Sites-carrefour-IT-Site/it_IT';

function order(number: string, opts: { status?: string; code?: string; receipt?: string | null; reorder?: boolean } = {}) {
  return {
    orderNumber: number,
    customerFirstName: 'Mario',
    customerLastName: 'Rossi',
    customerPhoneNumber: '+390000000000',
    customerEmail: 'mario@example.com',
    customerPaybackCardNumber: '0000000000000',
    paymentMethodDescriptions: [{ description: 'Paypal' }],
    orderTotal: { value: 12.5, currency: 'EUR', formatted: '€ 12,50' },
    shippingTotal: { value: 0.24, currency: 'EUR', formatted: '€ 0,24' },
    shipments: [
      {
        id: 'me',
        uuid: 'u1',
        C4_ShipmentNo: `${number}-1`,
        storeId: '0001',
        productCount: '3',
        shippingMetodDescription: 'Ritiro in negozio',
        shippingAddress: { address1: 'VIA FINTA 1', city: 'TORINO', firstName: 'Mario', phone: '000' },
        timeslotDate: '01/11/2026',
        timeslotStartTime: '18:00',
        timeslotEndTime: '20:00',
        status: { code: opts.code ?? 'ready_for_delivery', description: opts.status ?? 'Pronto per la consegna' },
        receiptUrl: opts.receipt === undefined ? 'https://carrefouritalia.my.salesforce.com/sfc/p/X/a/Y/receipt' : opts.receipt,
        invoiceUrl: null,
        trackingUrl: null,
        canBeReordered: opts.reorder ?? true,
        reorderUrl: `${BASE}/Order-Reorder?shipmentID=me&orderID=${number}&cShipmentNo=${number}-1`,
        canBeReturned: false,
        cShipmentNo: `${number}-1`,
      },
    ],
    orderDetailUrl: `/account/order?orderID=${number}`,
  };
}

const HISTORY = {
  action: 'Order-HistoryOrders',
  orderHistory: {
    orders: [order('00000002'), order('00000001', { status: 'Consegnato', code: 'delivered', receipt: null })],
    hasNextOrders: false,
  },
};

const q = (value: unknown) => JSON.stringify(value).replace(/"/g, '&quot;');
const DETAIL_PAGE = `
  <div class="order-product" data-pid="111" data-product-json="${q({ id: '111', name: 'Latte 1 l', price: '1.19', brand: 'Marca' })}">
    <a href="/p/latte/111.html">Latte 1 l</a><span>Quantità: 2</span>
    <button data-pid="111">Aggiungi</button>
  </div>
  <div class="order-product" data-pid="222">
    <a href="/p/pane/222.html">Pane 500 g</a><span>1 pz</span>
  </div>`;

const calls: FetchRequest[] = [];
let respond: (req: FetchRequest) => { type?: string; body: unknown };
const originalFetch = browserService.fetch.bind(browserService);

function happy(req: FetchRequest): { type?: string; body: unknown } {
  const path = new URL(req.url).pathname;
  if (path.endsWith('Store-SelectionBar')) return { body: { storeSelectionBar: '<div data-option-user-logged="true"></div>' } };
  if (path.endsWith('Order-HistoryOrders')) return { body: HISTORY };
  if (path === '/account/order') return { type: 'text/html', body: DETAIL_PAGE };
  if (path.endsWith('Order-Reorder')) {
    return { body: { error: false, message: 'Prodotti aggiunti al carrello', quantity: 3, cShipmentNo: 'x', totalPrice: '€ 12,26' } };
  }
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
  forgetLoginState();
  sessionService.clear();
  sessionService.importCookies('dwsid=abc');
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const server = new McpServer({ name: 'test', version: '0' });
  registerOrderTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const result = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, text: result.content[0].text };
}

const path = (req: FetchRequest) => new URL(req.url).pathname.split('/').pop();

test('parseOrderHistory keeps the order and leaves the customer\'s personal data out', () => {
  const { orders, has_more } = parseOrderHistory(HISTORY);
  assert.equal(has_more, false);
  assert.deepEqual(orders[0], {
    order_number: '00000002',
    total: '€ 12,50',
    shipping: '€ 0,24',
    payment: ['Paypal'],
    shipments: [
      {
        shipment_no: '00000002-1',
        shipment_id: 'me',
        method: 'Ritiro in negozio',
        store_id: '0001',
        city: 'TORINO',
        product_count: 3,
        status: 'Pronto per la consegna',
        status_code: 'ready_for_delivery',
        timeslot: '01/11/2026 18:00-20:00',
        receipt_url: 'https://carrefouritalia.my.salesforce.com/sfc/p/X/a/Y/receipt',
        can_reorder: true,
        reorder_url: `${BASE}/Order-Reorder?shipmentID=me&orderID=00000002&cShipmentNo=00000002-1`,
        can_return: false,
      },
    ],
    detail_url: 'https://www.carrefour.it/account/order?orderID=00000002',
  });
  const text = JSON.stringify(orders);
  for (const secret of ['Mario', 'Rossi', 'mario@example.com', '+390000000000', 'VIA FINTA', '0000000000000']) {
    assert.equal(text.includes(secret), false, `${secret} must not be returned`);
  }
});

test('parseOrderDetailProducts reads each line once, with its quantity', () => {
  assert.deepEqual(parseOrderDetailProducts(DETAIL_PAGE), [
    { ean: '111', name: 'Latte 1 l', brand: 'Marca', price: 1.19, url: 'https://www.carrefour.it/p/latte/111.html', quantity: 2 },
    { ean: '222', name: 'Pane 500 g', url: 'https://www.carrefour.it/p/pane/222.html', quantity: 1 },
  ]);
});

test('get_orders asks for the requested number of orders', async () => {
  const result = await run('get_orders', { limit: 5 });
  assert.equal(result.isError, false, result.text);
  const history = calls.find((c) => path(c) === 'Order-HistoryOrders')!;
  assert.equal(new URL(history.url).searchParams.get('sz'), '5');
  assert.equal(JSON.parse(result.text).count, 2);
});

test('get_order_status finds the order by number; without one it takes the latest', async () => {
  const one = JSON.parse((await run('get_order_status', { order_number: '00000001' })).text);
  assert.equal(one.order_number, '00000001');
  assert.equal(one.shipments[0].status, 'Consegnato');
  assert.equal(one.shipments[0].receipt_ready, false);

  const latest = JSON.parse((await run('get_order_status')).text);
  assert.equal(latest.order_number, '00000002');

  const missing = await run('get_order_status', { order_number: '99999999' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /not among the last/);
});

test('get_order_details joins the summary with the products of the detail page', async () => {
  const result = await run('get_order_details', { order_number: '00000002' });
  assert.equal(result.isError, false, result.text);
  const details = JSON.parse(result.text);
  assert.equal(details.total, '€ 12,50');
  assert.equal(details.product_count, 2);
  const page = calls.find((c) => new URL(c.url).pathname === '/account/order')!;
  assert.equal(new URL(page.url).searchParams.get('orderID'), '00000002');
});

test('get_order_receipt gives the PDF link, or says it is not ready yet', async () => {
  const ready = JSON.parse((await run('get_order_receipt', { order_number: '00000002' })).text);
  assert.equal(ready.documents[0].receipt_url, 'https://carrefouritalia.my.salesforce.com/sfc/p/X/a/Y/receipt');

  const notYet = await run('get_order_receipt', { order_number: '00000001' });
  assert.equal(notYet.isError, true);
  assert.match(notYet.text, /no receipt yet \(status: Consegnato\)/);
});

test('reorder_order calls the shipment\'s reorder link and reports the cart', async () => {
  const result = await run('reorder_order', { order_number: '00000002' });
  assert.equal(result.isError, false, result.text);
  const reorder = calls.find((c) => path(c) === 'Order-Reorder')!;
  const params = new URL(reorder.url).searchParams;
  assert.equal(params.get('orderID'), '00000002');
  assert.equal(params.get('cShipmentNo'), '00000002-1');
  assert.equal(params.get('shipmentID'), 'me');
  assert.deepEqual(JSON.parse(result.text).reordered[0], {
    shipment_no: '00000002-1',
    message: 'Prodotti aggiunti al carrello',
    cart_items: 3,
    cart_total: '€ 12,26',
  });
});

test('reorder_order reports carrefour.it\'s refusal', async () => {
  respond = (req) =>
    path(req) === 'Order-Reorder' ? { body: { error: true, message: 'Seleziona prima un servizio di consegna' } } : happy(req);
  const result = await run('reorder_order', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /Reorder: Seleziona prima un servizio di consegna/);
});

test('order tools refuse a guest session without asking for the history', async () => {
  respond = (req) =>
    path(req) === 'Store-SelectionBar' ? { body: { storeSelectionBar: '<div data-option-user-logged="false"></div>' } } : happy(req);
  const result = await run('get_orders');
  assert.equal(result.isError, true);
  assert.equal(calls.some((c) => path(c) === 'Order-HistoryOrders'), false);
});
