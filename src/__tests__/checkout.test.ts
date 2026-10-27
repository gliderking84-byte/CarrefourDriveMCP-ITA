import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchRequest, FetchResponse } from '../services/browser.service.js';

// The checkout tools end to end through a real MCP client, with carrefour.it scripted.

const dir = mkdtempSync(join(tmpdir(), 'carrefour-checkout-test-'));
process.env.CARREFOUR_SESSION_FILE = join(dir, 'cookies.json');
process.env.CARREFOUR_DATA_DIR = dir;
process.env.CARREFOUR_LOGIN_BROWSER = '/bin/true'; // "opens" the payment page harmlessly
process.env.MIN_DELAY_MS = '0';
process.env.MAX_DELAY_MS = '0';
process.env.RATE_LIMIT_REQUESTS = '1000';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { registerCheckoutTools, resetPreparedCheckout, shippingForm } = await import('../tools/checkout.tools.js');
const { browserService } = await import('../services/browser.service.js');
const { sessionService } = await import('../services/session.service.js');
const { forgetLoginState } = await import('../services/auth.service.js');

const calls: FetchRequest[] = [];
const visits: string[] = [];
let respond: (req: FetchRequest) => unknown;
let landing = 'https://www.carrefour.it/checkout/begin?cart=1&rurl=2';
const originalFetch = browserService.fetch.bind(browserService);
const originalVisit = browserService.visit.bind(browserService);

const ADDRESS = {
  customerAddressUUID: 'addr-1',
  firstName: 'Mario',
  lastName: 'Rossi',
  address1: 'Via Roma',
  houseNumber: '1',
  city: 'Milano',
  stateCode: 'MI',
  postalCode: '20121',
  floor: '2',
  stairs: null,
  hasLift: 'true',
  intercomName: 'Rossi',
  phone: '3330000000',
  country: 'IT',
};

const ORDER = {
  totals: {
    subTotal: '€ 45,34',
    totalShippingCost: '€ 7,50',
    grandTotal: '€ 53,08',
    orderLevelDiscountTotal: { value: 0, formatted: '€ 0,00' },
  },
  items: {
    totalQuantity: 2,
    items: [{ id: '800', productName: 'Latte', qtyincart: 2, priceTotal: { priceValue: 1.52 }, available: true }],
  },
};

const PICKUP_CART = '<div class="line-item-card"></div>';

/** The happy path, per endpoint. Tests override single answers. */
function happy(req: FetchRequest): unknown {
  const path = new URL(req.url).pathname;
  if (path.endsWith('Store-SelectionBar')) return { storeSelectionBar: '<div data-option-user-logged="true"></div>' };
  if (path.endsWith('CSRF-Generate')) return { csrf: { tokenName: 'csrf_token', token: 'TOKEN' } };
  if (path.endsWith('Account-AddressBook')) return { csrf: { token: 'TOKEN' }, addressList: [ADDRESS] };
  if (path.endsWith('TimeSlotApi-ReserveTimeSlot')) return { error: false, reservedTimeslot: { shipmentUUID: 'ship-1' } };
  if (path === '/checkout/shipping-submit') return { order: ORDER, queryString: 'csrf_token=TOKEN' };
  if (path.endsWith('CheckoutShippingServices-ValidateShippingAddress')) return { error: false };
  if (path.endsWith('Minicart-Show')) return PICKUP_CART;
  if (path.endsWith('Checkout-UpdateTimeslot')) return { error: false, csrf: { token: 'TOKEN' }, timeslotDateFormatted: 'Giovedì 29 ottobre | 17:00 - 21:00' };
  if (path === '/checkout/payment') {
    return {
      redirectUrl:
        'https://www.carrefour.it/on/demandware.store/Sites-carrefour-IT-Site/it_IT/PayOnline-Checkout?seu=https%3a%2f%2fhpp.example%2fcheckout&orderNumber=03070001',
    };
  }
  return {};
}

before(() => {
  browserService.fetch = async (req: FetchRequest): Promise<FetchResponse> => {
    calls.push(req);
    return {
      status: 200,
      statusText: 'OK',
      ok: true,
      url: req.url,
      contentType: 'application/json',
      text: JSON.stringify(respond(req)),
    };
  };
  browserService.visit = async (url: string) => {
    visits.push(url);
    return { status: 200, finalUrl: landing };
  };
});

after(() => {
  browserService.fetch = originalFetch;
  browserService.visit = originalVisit;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  visits.length = 0;
  respond = happy;
  landing = 'https://www.carrefour.it/checkout/begin?cart=1&rurl=2';
  forgetLoginState();
  resetPreparedCheckout();
  sessionService.clear();
  sessionService.importCookies('dwsid=abc');
});

async function client() {
  const server = new McpServer({ name: 'test', version: '0' });
  registerCheckoutTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  return c;
}

async function run(c: Awaited<ReturnType<typeof client>>, name: string, args: Record<string, unknown> = {}) {
  const result = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, text: result.content[0].text };
}

const SLOT = {
  timeslotId: 'slot-1',
  timeslotStart: '2026-10-29T17:00:00.000',
  timeslotEnd: '2026-10-29T21:00:00.000',
  timeslotEco: true,
  storeId: '1234',
};

const step = (req: FetchRequest) => new URL(req.url).pathname.split('/').pop();
const form = (req: FetchRequest) => Object.fromEntries(req.formEntries ?? []);

test('shippingForm maps a saved address onto the checkout form fields', () => {
  const f = shippingForm(ADDRESS, '+39');
  assert.equal(f.dwfrm_shipping_shippingAddress_addressFields_customerAddressUUID, 'addr-1');
  assert.equal(f.dwfrm_shipping_shippingAddress_addressFields_postalCode, '20121');
  assert.equal(f.dwfrm_shipping_shippingAddress_addressFields_stairs, '', 'null fields are sent empty');
  assert.equal(f.dwfrm_shipping_shippingAddress_addressFields_phonePrefix, '+39');
});

test('prepare_checkout chains reservation, checkout, address and slot, and orders nothing', async () => {
  const c = await client();
  const res = await run(c, 'prepare_checkout', SLOT);

  assert.equal(res.isError, false, res.text);
  assert.deepEqual(
    calls.map(step).filter((s) => s !== 'CSRF-Generate'),
    [
      'Store-SelectionBar',
      'Account-AddressBook',
      'TimeSlotApi-ReserveTimeSlot',
      'shipping-submit',
      'CheckoutShippingServices-ValidateShippingAddress',
      'Checkout-UpdateTimeslot',
    ]
  );
  assert.deepEqual(visits, ['https://www.carrefour.it/checkout/begin?cart=1&rurl=2']);
  assert.equal(calls.some((r) => step(r) === 'payment'), false, 'preparing must never create the order');

  const shipping = form(calls.find((r) => step(r) === 'shipping-submit')!);
  assert.equal(shipping.shipmentUUID, 'ship-1', 'the shipment from the reservation is reused');
  assert.equal(shipping.dwfrm_shipping_shippingAddress_addressFields_address1, 'Via Roma');
  assert.equal(shipping.csrf_token, 'TOKEN');
  assert.equal(form(calls.find((r) => step(r) === 'Checkout-UpdateTimeslot')!).uuid, 'ship-1');

  assert.match(res.text, /NOT ordered yet/);
  assert.match(res.text, /€ 53,08/);
  assert.match(res.text, /Giovedì 29 ottobre/);
  assert.equal(res.text.includes('TOKEN'), false);
});

test('prepare_checkout stops on an address that does not match the delivery CAP', async () => {
  respond = (req) =>
    step(req) === 'CheckoutShippingServices-ValidateShippingAddress'
      ? { error: true, errorMessage: '<span>Il CAP e il Comune non corrispondono.</span> Modifica la scelta.' }
      : happy(req);
  const c = await client();
  const res = await run(c, 'prepare_checkout', SLOT);
  assert.equal(res.isError, true);
  assert.match(res.text, /Il CAP e il Comune non corrispondono\. Modifica la scelta\./);

  // Nothing was prepared, so nothing can be placed.
  const placed = await run(c, 'place_order', { confirm: true });
  assert.equal(placed.isError, true);
  assert.equal(calls.some((r) => step(r) === 'payment'), false);
});

test('prepare_checkout reports the checkout bouncing back to the cart', async () => {
  landing = 'https://www.carrefour.it/cart?fromAddressMismatch=true';
  const c = await client();
  const res = await run(c, 'prepare_checkout', SLOT);
  assert.equal(res.isError, true);
  assert.match(res.text, /\/cart\?fromAddressMismatch=true/);
  assert.equal(calls.some((r) => step(r) === 'shipping-submit'), false);
});

test('prepare_checkout asks which address when the account has several', async () => {
  respond = (req) =>
    step(req) === 'Account-AddressBook'
      ? { addressList: [ADDRESS, { ...ADDRESS, customerAddressUUID: 'addr-2' }] }
      : happy(req);
  const c = await client();
  const res = await run(c, 'prepare_checkout', SLOT);
  assert.equal(res.isError, true);
  assert.match(res.text, /address_id/);
});

test('place_order refuses without confirm, and without a prepared checkout', async () => {
  const c = await client();
  assert.equal((await run(c, 'place_order', { confirm: false })).isError, true);
  assert.equal((await run(c, 'place_order', { confirm: true })).isError, true);
  assert.equal(calls.some((r) => step(r) === 'payment'), false);
});

test('place_order creates the order once and hands the payment page over', async () => {
  const c = await client();
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  calls.length = 0;

  const res = await run(c, 'place_order', { confirm: true });
  assert.equal(res.isError, false, res.text);
  const payment = calls.find((r) => step(r) === 'payment')!;
  assert.deepEqual(form(payment), {
    paymentOptions: 'MP_PAYPAL',
    billingAddressEnabled: 'false',
    orderNotes: '',
    csrf_token: 'TOKEN',
    timeslotEnabled: 'true',
  });
  assert.match(res.text, /Order 03070001 created/);
  assert.match(res.text, /PayOnline-Checkout/);

  // A second call must not create a second order.
  const again = await run(c, 'place_order', { confirm: true });
  assert.equal(again.isError, true);
  assert.equal(calls.filter((r) => step(r) === 'payment').length, 1);
});

test('apply_coupon turns SFCC field errors into a tool error', async () => {
  respond = (req) =>
    step(req) === 'CheckoutServices-AddCoupon'
      ? { errorFields: { couponCode: 'Il codice sconto non è stato riconosciuto' } }
      : happy(req);
  const c = await client();
  const res = await run(c, 'apply_coupon', { code: '12345' });
  assert.equal(res.isError, true);
  assert.match(res.text, /couponCode: Il codice sconto non è stato riconosciuto/);
  assert.equal(form(calls.find((r) => step(r) === 'CheckoutServices-AddCoupon')!).couponCode, '12345');
});

test('prepare_checkout for pickup reserves with the store CAP and submits no address', async () => {
  const c = await client();
  const res = await run(c, 'prepare_checkout', {
    ...SLOT,
    shippingMethodId: 'pickup_in_store',
    storeId: '0551',
    store_cap: '10040',
    store_city: "LEINI'",
  });
  assert.equal(res.isError, false, res.text);

  const reserve = form(calls.find((r) => step(r) === 'TimeSlotApi-ReserveTimeSlot')!);
  assert.equal(reserve.shippingMethodId, 'pickup_in_store');
  assert.equal(reserve.cap, '10040');
  assert.equal(reserve.city, "LEINI'");
  assert.equal('address' in reserve, false, 'the site sends no address fields for pickup');
  assert.equal(calls.some((r) => step(r) === 'Account-AddressBook' || step(r) === 'shipping-submit'), false);
  assert.ok(calls.some((r) => step(r) === 'Checkout-UpdateTimeslot'));
  assert.match(res.text, /ritiro in negozio 0551/);

  const placed = await run(c, 'place_order', { confirm: true });
  assert.equal(placed.isError, false, placed.text);
});

test('prepare_checkout for pickup needs the store CAP and city', async () => {
  const c = await client();
  const res = await run(c, 'prepare_checkout', { ...SLOT, shippingMethodId: 'pickup_in_store' });
  assert.equal(res.isError, true);
  assert.match(res.text, /store_cap and store_city/);
  assert.equal(calls.some((r) => step(r) === 'TimeSlotApi-ReserveTimeSlot'), false);
});
