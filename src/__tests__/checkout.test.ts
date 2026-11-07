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
const { registerCheckoutTools, resetPreparedCheckout, shippingForm, feesFromPageText } = await import('../tools/checkout.tools.js');
const { browserService } = await import('../services/browser.service.js');
const { sessionService } = await import('../services/session.service.js');
const { forgetLoginState } = await import('../services/auth.service.js');

const calls: FetchRequest[] = [];
const visits: string[] = [];
let respond: (req: FetchRequest) => unknown;
let landing = 'https://www.carrefour.it/checkout/begin?cart=1&rurl=2';
const originalFetch = browserService.fetch.bind(browserService);
const originalVisit = browserService.visit.bind(browserService);
const originalFollow = browserService.followRedirect.bind(browserService);
const originalMessages = browserService.pageMessages.bind(browserService);
const originalPayPal = browserService.payPalFromProvider.bind(browserService);
const originalCard = browserService.cardPageFrom.bind(browserService);
/** Market Pay's card page as carrefour.it shows it; url '' = not found. */
let cardFrame = { url: '', fields: 0, standaloneFields: 0 };
/** PayPal behind the provider's page ("Paga" pressed there); '' = not reached. */
let paypalBehind = '';
const pressed: string[] = [];
/** PayPal reached by pressing "Paga" on carrefour.it's payment page; '' = not reached. */
let paypalViaCarrefour = '';
const viaCarrefour: string[] = [];
let landings: string[] = [];
let cartMessages: string[] = [];
let paypalLanding: string | null = null;

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
    return { status: 200, finalUrl: landings.length ? landings.shift()! : landing };
  };
  browserService.pageMessages = async () => cartMessages;
  browserService.cardPageFrom = async () => cardFrame;
  browserService.payPalFromProvider = async (url: string) => {
    // carrefour.it's own payment page: lands on PayPal by itself, or "Paga" pressed in Market Pay's iframe
    if (/carrefour\.it/.test(url)) {
      if (paypalLanding && /paypal\.com/.test(paypalLanding)) return paypalLanding;
      viaCarrefour.push(url);
      return paypalViaCarrefour;
    }
    pressed.push(url);
    return paypalBehind;
  };
  browserService.followRedirect = async () => {
    if (!paypalLanding) throw new Error('timeout');
    return paypalLanding;
  };
});

after(() => {
  browserService.fetch = originalFetch;
  browserService.visit = originalVisit;
  browserService.followRedirect = originalFollow;
  browserService.pageMessages = originalMessages;
  browserService.payPalFromProvider = originalPayPal;
  browserService.cardPageFrom = originalCard;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  pressed.length = 0;
  paypalBehind = '';
  viaCarrefour.length = 0;
  paypalViaCarrefour = '';
  cardFrame = { url: '', fields: 0, standaloneFields: 0 };
  visits.length = 0;
  respond = happy;
  landing = 'https://www.carrefour.it/checkout/begin?cart=1&rurl=2';
  landings = [];
  cartMessages = [];
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
      'Minicart-Show',
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

test('prepare_checkout stops before the checkout when the new store cannot supply some products', async () => {
  const q = (v: unknown) => JSON.stringify(v).replace(/"/g, '&quot;');
  const cart =
    `<div class="line-item-card item-unavailable"><div class="card" data-product-json="${q({ id: '111', name: 'Uova 6' })}" ` +
    'data-product-quantity="2"></div></div>';
  respond = (req) => (step(req) === 'Minicart-Show' ? cart : happy(req));
  const c = await client();
  const res = await run(c, 'prepare_checkout', SLOT);
  assert.equal(res.isError, true);
  assert.match(res.text, /1 product\(s\) in the cart are not available at this store\/service: Uova 6 \(111\)/);
  assert.match(res.text, /remove_unavailable_products/);
  assert.deepEqual(visits, [], 'the checkout is not opened');
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

  assert.doesNotMatch(res.text, /Payment link \(PayPal/, 'no PayPal link when the redirect cannot be followed');
  // the provider page from `seu` comes first, never the carrefour.it page (a 404 without the session)
  assert.equal([...res.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])[0], 'https://hpp.example/checkout');
  assert.match(res.text, /Market Pay page: press "Paga" there/);
  assert.match(res.text, /not opened on the server/);

  // A second call must not create a second order.
  const again = await run(c, 'place_order', { confirm: true });
  assert.equal(again.isError, true);
  assert.equal(calls.filter((r) => step(r) === 'payment').length, 1);
});

test('place_order with PayPal hands over the Market Pay page and presses nothing on the server', async () => {
  const c = await client();
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  const res = await run(c, 'place_order', { confirm: true });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /https:\/\/hpp\.example\/checkout/);
  assert.doesNotMatch(res.text, /paypal\.com/);
  assert.match(res.text, /the whole payment must happen in the browser that opens this link/);
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

test('feesFromPageText reads the pickup fee and the total from the checkout summary', () => {
  const page = 'Ritiro in negozio\nLEINI\', 10040\nModifica\nTOTALE PRODOTTI\n€ 31,78\nSpesa Online (17)\n€ 31,78\nSpese di ritiro e sacchetti/cartoni\n€ 0,24\nTOTALE\n€ 32,02\nAggiungi prodotti\nCompleta ordine';
  assert.deepEqual(feesFromPageText(page), {
    products_total: '€ 31,78',
    delivery_cost: '€ 0,24',
    delivery_cost_label: 'Spese di ritiro e sacchetti/cartoni',
    total_to_pay: '€ 32,02',
  });
  assert.deepEqual(feesFromPageText('Nessun riepilogo qui'), {});
});

test('prepare_checkout for pickup shows the pickup fee and the total to pay from the checkout page', async () => {
  const originalText = browserService.pageText.bind(browserService);
  browserService.pageText = async () => 'TOTALE PRODOTTI € 31,78\nSpese di ritiro e sacchetti/cartoni € 0,24\nTOTALE € 32,02';
  try {
    const c = await client();
    const res = await run(c, 'prepare_checkout', { ...SLOT, shippingMethodId: 'pickup_in_store', storeId: '0551', store_cap: '10040', store_city: "LEINI'" });
    assert.equal(res.isError, false, res.text);
    const summary = JSON.parse(res.text.slice(0, res.text.indexOf('\n\nNothing')));
    assert.equal(summary.delivery_cost, '€ 0,24');
    assert.equal(summary.total_to_pay, '€ 32,02');
    assert.equal('note' in summary, false);
  } finally {
    browserService.pageText = originalText;
  }
});

test('prepare_checkout for pickup needs the store CAP and city', async () => {
  const c = await client();
  const res = await run(c, 'prepare_checkout', { ...SLOT, shippingMethodId: 'pickup_in_store' });
  assert.equal(res.isError, true);
  assert.match(res.text, /store_cap and store_city/);
  assert.equal(calls.some((r) => step(r) === 'TimeSlotApi-ReserveTimeSlot'), false);
});

test('place_order hands over the PayPal link when carrefour.it redirects there', async () => {
  process.env.CARREFOUR_PAYPAL_DIRECT = '1'; // old behaviour, still available
  try {
  paypalLanding = 'https://www.paypal.com/checkoutnow?token=EC-TEST123';
  try {
    const c = await client();
    assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
    const res = await run(c, 'place_order', { confirm: true });
    assert.equal(res.isError, false, res.text);
    const links = [...res.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
    assert.equal(links[0], paypalLanding, 'the PayPal link comes first');
    assert.match(res.text, /Payment link \(PayPal/);
    assert.deepEqual(pressed, [], 'already on PayPal: nothing to press');
  } finally {
    paypalLanding = null;
  }
  } finally {
    delete process.env.CARREFOUR_PAYPAL_DIRECT;
  }
});

test('place_order presses Paga on the provider page and hands over PayPal (the app on a phone)', async () => {
  process.env.CARREFOUR_PAYPAL_DIRECT = '1'; // old behaviour, still available
  try {
  paypalLanding = 'https://hpp2.prod.mpg.market-pay.com/hppv22/selection.hpp?sessionId=S1#pay=EWALLET_PAYPAL';
  paypalBehind = 'https://www.paypal.com/checkoutnow?token=EC-BEHIND';
  try {
    const c = await client();
    assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
    const res = await run(c, 'place_order', { confirm: true });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(pressed, [paypalLanding], 'Paga pressed on the provider page, once');
    assert.equal([...res.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])[0], paypalBehind);
    assert.match(res.text, /Payment link \(PayPal/);
  } finally {
    paypalLanding = null;
  }
  } finally {
    delete process.env.CARREFOUR_PAYPAL_DIRECT;
  }
});

test("place_order presses Paga on carrefour.it's payment page first, as the user does", async () => {
  process.env.CARREFOUR_PAYPAL_DIRECT = '1'; // old behaviour, still available
  try {
  paypalLanding = 'https://hpp2.prod.mpg.market-pay.com/hppv22/checkout.hpp?sessionId=S3';
  paypalViaCarrefour = 'https://www.paypal.com/checkoutnow?token=EC-VIA-CARREFOUR';
  try {
    const c = await client();
    assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
    const res = await run(c, 'place_order', { confirm: true });
    assert.equal(res.isError, false, res.text);
    assert.equal(viaCarrefour.length, 1);
    assert.match(viaCarrefour[0], /PayOnline-Checkout/);
    assert.deepEqual(pressed, [], "Market Pay's page on its own is not needed");
    assert.equal([...res.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])[0], paypalViaCarrefour);
  } finally {
    paypalLanding = null;
  }
  } finally {
    delete process.env.CARREFOUR_PAYPAL_DIRECT;
  }
});

test('place_order keeps the provider page when PayPal is not reached behind it', async () => {
  process.env.CARREFOUR_PAYPAL_DIRECT = '1'; // old behaviour, still available
  try {
  paypalLanding = 'https://hpp2.prod.mpg.market-pay.com/hppv22/selection.hpp?sessionId=S2#pay=EWALLET_PAYPAL';
  try {
    const c = await client();
    assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
    const res = await run(c, 'place_order', { confirm: true });
    assert.equal(res.isError, false, res.text);
    assert.equal([...res.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])[0], paypalLanding);
    assert.match(res.text, /Market Pay page: press "Paga" there/);
  } finally {
    paypalLanding = null;
  }
  } finally {
    delete process.env.CARREFOUR_PAYPAL_DIRECT;
  }
});

test('prepare_checkout retries once when the checkout bounces to the cart (recalculated basket)', async () => {
  landings = ['https://www.carrefour.it/cart', 'https://www.carrefour.it/checkout/begin?cart=1&rurl=2'];
  const c = await client();
  const res = await run(c, 'prepare_checkout', SLOT);
  assert.equal(res.isError, false, res.text);
  assert.equal(visits.filter((v) => v.includes('/checkout/begin')).length, 2);
});

test('prepare_checkout reports what the cart page says when the checkout keeps bouncing', async () => {
  landing = 'https://www.carrefour.it/cart';
  cartMessages = ['Il prodotto Finocchi 1 kg non è disponibile per la fascia scelta'];
  const c = await client();
  const res = await run(c, 'prepare_checkout', SLOT);
  assert.equal(res.isError, true);
  assert.match(res.text, /The cart page says: "Il prodotto Finocchi 1 kg non è disponibile per la fascia scelta"/);
  assert.equal(visits.filter((v) => v.includes('/checkout/begin')).length, 2, 'one retry only');
});

test('renew_payment_link follows the order\'s payment page to a new PayPal link', async () => {
  process.env.CARREFOUR_PAYPAL_DIRECT = '1'; // old behaviour, still available
  try {
  const c = await client();
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  const placed = await run(c, 'place_order', { confirm: true });
  assert.match(placed.text, /renew_payment_link/);
  const page = /carrefour\.it payment page: (\S+?)\)/.exec(placed.text)![1];
  assert.match(page, /orderNumber=03070001/);

  paypalLanding = 'https://www.paypal.com/checkoutnow?token=EC-NEW';
  try {
    const res = await run(c, 'renew_payment_link', { order_number: '03070001' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /EC-NEW/);
    assert.equal(calls.filter((r) => step(r) === 'payment').length, 1, 'no new order');
  } finally {
    paypalLanding = null;
  }
  // carrefour.it does not reach PayPal any more: cancelled or paid
  const gone = await run(c, 'renew_payment_link', { order_number: '03070001' });
  assert.equal(gone.isError, true);
  assert.match(gone.text, /no longer sends order 03070001 to PayPal/);
  } finally {
    delete process.env.CARREFOUR_PAYPAL_DIRECT;
  }
});

test('renew_payment_link only accepts this order\'s carrefour.it payment page', async () => {
  const c = await client();
  const bad = await run(c, 'renew_payment_link', { order_number: '123', payment_page_url: 'https://evil.example/pay?orderNumber=123' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /must be the carrefour\.it payment page/);
  const other = await run(c, 'renew_payment_link', { order_number: '123', payment_page_url: 'https://www.carrefour.it/x/PayOnline-Checkout?orderNumber=999' });
  assert.equal(other.isError, true);
  const unknown = await run(c, 'renew_payment_link', { order_number: '555' });
  assert.match(unknown.text, /No payment page known for order 555/);
});

test('providerPageOf reads the hosted payment page, never a carrefour.it one', async () => {
  const { providerPageOf } = await import('../tools/checkout.tools.js');
  assert.equal(providerPageOf('https://www.carrefour.it/x/PayOnline-Checkout?seu=https%3a%2f%2fhpp.example%2fcheckout%3ftoken%3dA&orderNumber=1'), 'https://hpp.example/checkout?token=A');
  assert.equal(providerPageOf('https://www.carrefour.it/x/PayOnline-Checkout?seu=https%3a%2f%2fwww.carrefour.it%2fcart&orderNumber=1'), '');
  assert.equal(providerPageOf('https://www.carrefour.it/x/PayOnline-Checkout?orderNumber=1'), '');
  assert.equal(providerPageOf('not a url'), '');
});

test('place_order by card sends MARKETPAY and hands over the card page, pressing nothing', async () => {
  const c = await client();
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  calls.length = 0;
  paypalLanding = 'https://hpp.example/selection';
  paypalBehind = 'https://www.paypal.com/checkoutnow?token=T';

  const res = await run(c, 'place_order', { confirm: true, payment_method: 'MARKETPAY' });
  assert.equal(res.isError, false, res.text);
  assert.equal(form(calls.find((r) => step(r) === 'payment')!).paymentOptions, 'MARKETPAY');
  assert.deepEqual(pressed, [], 'nothing is pressed on the card page');
  assert.equal([...res.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])[0], 'https://hpp.example/checkout');
  assert.match(res.text, /Card payment link \(Mastercard, Visa or American Express/);
  assert.match(res.text, /pre-authorised/);
  assert.doesNotMatch(res.text, /paypal\.com/);

  // A renewed link for this order stays on the card page.
  const renewed = await run(c, 'renew_payment_link', { order_number: '03070001' });
  assert.equal(renewed.isError, false, renewed.text);
  assert.match(renewed.text, /New card payment link/);
  assert.match(renewed.text, /https:\/\/hpp\.example\/selection/);
  assert.deepEqual(pressed, []);
});

test('place_order by card hands over the card page exactly as carrefour.it shows it', async () => {
  cardFrame = { url: 'https://hpp.example/selection.hpp?sessionId=S#pay=CARD', fields: 3, standaloneFields: 3 };
  const c = await client();
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  const res = await run(c, 'place_order', { confirm: true, payment_method: 'MARKETPAY' });
  assert.equal(res.isError, false, res.text);
  assert.equal([...res.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])[0], cardFrame.url, 'the URL carrefour.it uses, hash included');
  assert.doesNotMatch(res.text, /CARD_FIELDS/);

  // fields only inside carrefour.it: the link alone is not enough, and the tool says so
  cardFrame = { url: 'https://hpp.example/card', fields: 3, standaloneFields: 0 };
  const renewed = await run(c, 'renew_payment_link', { order_number: '03070001' });
  assert.equal(renewed.isError, false, renewed.text);
  assert.match(renewed.text, /https:\/\/hpp\.example\/card/);
  assert.match(renewed.text, /CARD_FIELDS_ONLY_ON_CARREFOUR/);

  cardFrame = { url: 'https://hpp.example/card', fields: 0, standaloneFields: 0 };
  const none = await run(c, 'renew_payment_link', { order_number: '03070001' });
  assert.match(none.text, /CARD_FIELDS_NOT_FOUND/);
});

test('place_order explains a bare "error: true" and never posts when the slot is gone', async () => {
  const c = await client();
  const posts = () => calls.filter((r) => new URL(r.url).pathname === '/checkout/payment').length;
  let held = true;
  let answer: unknown = { error: true };
  respond = (req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith('Store-ShowTimeslotReserved'))
      return held
        ? { shippingMethodIdSelected: 'pickup_in_store', shippingSelectedCAP: '10040', storeIdSelected: '0551', timeslotReserved: 'Mercoledì 4 novembre | 18:00 - 20:00', minutesBeforeTimeslotExpiry: 20 }
        : { shippingMethodIdSelected: 'pickup_in_store', shippingSelectedCAP: '10040', storeIdSelected: '0551' };
    if (path === '/checkout/payment') {
      held = held && answer !== 'slot-gone';
      return answer === 'slot-gone' ? { error: true } : answer;
    }
    return happy(req);
  };

  // 1. slot gone before: nothing is posted
  held = false;
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  held = false;
  let res = await run(c, 'place_order', { confirm: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /TIMESLOT_EXPIRED/);
  assert.equal(posts(), 0, 'no order attempt without a slot');

  // 2. bare error, slot gone right after
  held = true;
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  answer = 'slot-gone';
  res = await run(c, 'place_order', { confirm: true });
  assert.match(res.text, /TIMESLOT_EXPIRED/);
  assert.match(res.text, /No order was created/);

  // 3. basket sent back to the cart
  held = true;
  answer = { error: true, cartError: true, redirectUrl: '/cart' };
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  res = await run(c, 'place_order', { confirm: true });
  assert.match(res.text, /CART_CHANGED/);

  // 4. bare error with the slot still held: what carrefour.it said, and how to go on
  answer = { error: true, errorStage: { stage: 'payment', step: 'paymentInstrument' } };
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  res = await run(c, 'place_order', { confirm: true });
  assert.match(res.text, /carrefour\.it reported an error/);
  assert.match(res.text, /paymentInstrument/);
  assert.match(res.text, /No order was created/);
});

test('place_order refuses an unknown payment method before creating anything', async () => {
  const c = await client();
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  calls.length = 0;
  const res = await run(c, 'place_order', { confirm: true, payment_method: 'BUONI_PASTO' });
  assert.equal(res.isError, true);
  assert.equal(calls.some((r) => step(r) === 'payment'), false);
});

/** The payment block, as a program reads it: structured content, and the same JSON in the second text block. */
async function paymentBlock(c: Awaited<ReturnType<typeof client>>, name: string, args: Record<string, unknown>) {
  const result = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: { payment?: Record<string, unknown> };
  };
  assert.equal(result.isError === true, false, result.content[0].text);
  assert.equal(result.content.length, 2);
  assert.deepEqual(JSON.parse(result.content[1].text), result.structuredContent);
  return result.structuredContent!.payment!;
}

test('place_order by card returns a payment block a PWA can open', async () => {
  const c = await client();
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  const payment = await paymentBlock(c, 'place_order', { confirm: true, payment_method: 'MARKETPAY' });
  assert.deepEqual(payment, {
    order_number: '03070001',
    payment_method: 'MARKETPAY',
    payment_url: 'https://hpp.example/checkout',
    provider: 'market_pay_card',
    carrefour_payment_page:
      'https://www.carrefour.it/on/demandware.store/Sites-carrefour-IT-Site/it_IT/PayOnline-Checkout?seu=https%3a%2f%2fhpp.example%2fcheckout&orderNumber=03070001',
    total: payment.total,
    check_with: 'get_order_status',
  });
  assert.ok(payment.total, 'the total from prepare_checkout');
});

test('place_order with PayPal returns the PayPal link and its 3-hour validity in the block', async () => {
  process.env.CARREFOUR_PAYPAL_DIRECT = '1'; // old behaviour, still available
  try {
  const c = await client();
  assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
  paypalBehind = 'https://www.paypal.com/checkoutnow?token=EC-1';
  const payment = await paymentBlock(c, 'place_order', { confirm: true });
  assert.equal(payment.payment_method, 'MP_PAYPAL');
  assert.equal(payment.payment_url, 'https://www.paypal.com/checkoutnow?token=EC-1');
  assert.equal(payment.provider, 'paypal');
  assert.equal(payment.expires_in_hours, 3);

  paypalLanding = 'https://www.paypal.com/checkoutnow?token=EC-2';
  try {
    const renewed = await paymentBlock(c, 'renew_payment_link', { order_number: '03070001' });
    assert.equal(renewed.payment_url, 'https://www.paypal.com/checkoutnow?token=EC-2');
    assert.equal(renewed.provider, 'paypal');
  } finally {
    paypalLanding = null;
  }
  } finally {
    delete process.env.CARREFOUR_PAYPAL_DIRECT;
  }
});

test('a refused order carries no payment block', async () => {
  const c = await client();
  const result = (await c.callTool({ name: 'place_order', arguments: { confirm: true } })) as {
    isError?: boolean;
    structuredContent?: unknown;
  };
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
});

test('the card payment block says whether the link alone shows the card form', async () => {
  for (const [frame, expected] of [
    [{ url: 'https://hpp.example/selection.hpp?sessionId=S#pay=CARD', fields: 3, standaloneFields: 3 }, true],
    [{ url: 'https://hpp.example/card', fields: 3, standaloneFields: 0 }, false],
  ] as const) {
    resetPreparedCheckout();
    cardFrame = { ...frame };
    const c = await client();
    assert.equal((await run(c, 'prepare_checkout', SLOT)).isError, false);
    const payment = await paymentBlock(c, 'place_order', { confirm: true, payment_method: 'MARKETPAY' });
    assert.equal(payment.payment_url, frame.url);
    assert.equal(payment.link_shows_card_form, expected);
  }
});
