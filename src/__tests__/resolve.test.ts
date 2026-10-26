import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, buildQuery, substitute, substituteUrl, MISSING } from '../spec/resolve.js';
import { loadToolSpecs } from '../spec/loader.js';
import type { ToolSpec } from '../spec/types.js';

const { specs } = loadToolSpecs();
const byName = new Map(specs.map((s) => [s.name, s]));

function spec(name: string): ToolSpec {
  const s = byName.get(name);
  assert.ok(s, `tool "${name}" not found in tools/`);
  return s;
}

// --- $param substitution -----------------------------------------------------

test('substitute replaces a plain placeholder', () => {
  assert.equal(substitute({ $param: 'ean' }, { ean: '3560070' }), '3560070');
});

test('substitute keeps non-string types intact', () => {
  assert.equal(substitute({ $param: 'counter' }, { counter: 3 }), 3);
  assert.equal(substitute({ $param: 'flag' }, { flag: false }), false);
  assert.deepEqual(substitute({ $param: 'list' }, { list: ['a', 'b'] }), ['a', 'b']);
});

test('substitute recurses into nested objects and arrays', () => {
  const template = {
    items: [{ ean: { $param: 'ean' }, counter: { $param: 'counter' } }],
    tracking: { pageType: { $param: 'pageType' } },
  };
  assert.deepEqual(substitute(template, { ean: 'X', counter: 2, pageType: 'search' }), {
    items: [{ ean: 'X', counter: 2 }],
    tracking: { pageType: 'search' },
  });
});

test('substitute drops placeholders with no argument', () => {
  assert.equal(substitute({ $param: 'nope' }, {}), MISSING);
  assert.deepEqual(substitute({ a: { $param: 'a' }, b: { $param: 'b' } }, { a: 1 }), { a: 1 });
  assert.deepEqual(substitute([{ $param: 'a' }, { $param: 'b' }], { b: 2 }), [2]);
});

test('an object with extra keys next to $param is not treated as a placeholder', () => {
  assert.deepEqual(substitute({ $param: 'a', other: 1 } as never, { a: 'v' }), { $param: 'a', other: 1 });
});

// --- URL path segments -------------------------------------------------------

test('substituteUrl fills and encodes path segments', () => {
  assert.equal(
    substituteUrl('https://x/api/{a}/{b}', { a: 'drive clcv', b: '1-2/3' }),
    'https://x/api/drive%20clcv/1-2%2F3'
  );
});

test('substituteUrl throws when a path segment is missing', () => {
  assert.throws(() => substituteUrl('https://x/api/{a}', {}), /Missing required URL path parameter "a"/);
});

// --- Query strings -----------------------------------------------------------

test('buildQuery expands arrays into repeated keys', () => {
  const q = buildQuery({ 'codes[]': { $param: 'codes' } }, { codes: ['14', '15'] });
  assert.equal(q.toString(), 'codes%5B%5D=14&codes%5B%5D=15');
});

test('buildQuery skips absent optional params', () => {
  const q = buildQuery({ a: { $param: 'a' }, b: { $param: 'b' } }, { a: 'x' });
  assert.equal(q.toString(), 'a=x');
});

// --- Whole-request construction on real tool definitions ---------------------

const SFCC = 'https://www.carrefour.it/on/demandware.store/Sites-carrefour-IT-Site/it_IT';

test('browse_category: GET with query, optional params left out, no body', () => {
  const req = buildRequest(spec('browse_category'), { cgid: 'latte', start: 25 });
  assert.equal(req.method, 'GET');
  assert.equal(req.url, `${SFCC}/Search-UpdateGrid?cgid=latte&start=25`);
  assert.equal(req.body, undefined);
  assert.equal(req.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(req.headers['content-type'], undefined);
});

test('find_stores: one argument fills two query keys, fixed values are always sent', () => {
  const req = buildRequest(spec('find_stores'), { cap: '20121', city: 'Milano', state: 'MI' });
  const url = new URL(req.url);
  assert.equal(url.pathname, '/on/demandware.store/Sites-carrefour-IT-Site/it_IT/Store-Search');
  assert.equal(url.searchParams.get('cap'), '20121');
  assert.equal(url.searchParams.get('administrativeAreaLevel3'), 'Milano');
  assert.equal(url.searchParams.get('isGeneric'), '1');
  assert.equal(url.searchParams.get('timeslotEnabled'), 'true');
  assert.equal(url.searchParams.has('lat'), false);
});

test('add_to_cart: multipart form with the injected CSRF token and a default quantity', () => {
  const req = buildRequest(spec('add_to_cart'), { ean: '8002580010945', csrf_token: 'tok' });
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://www.carrefour.it/cart/add-product');
  assert.ok(req.body instanceof FormData);
  const form = req.body as FormData;
  assert.equal(form.get('pid'), '8002580010945');
  assert.equal(form.get('csrf_token'), 'tok');
  assert.equal(form.get('quantity'), '1');
  assert.equal(form.get('options'), '[]');
  assert.equal(req.headers['content-type'], undefined);
});

test('add_to_cart: an explicit quantity wins over the default', () => {
  const form = buildRequest(spec('add_to_cart'), { ean: '1', quantity: 3, csrf_token: 'tok' }).body as FormData;
  assert.equal(form.get('quantity'), '3');
});

test('update_cart_item_quantity: GET carrying the CSRF token and a boolean', () => {
  const req = buildRequest(spec('update_cart_item_quantity'), { ean: '123', decrease: true, csrf_token: 'tok' });
  const url = new URL(req.url);
  assert.equal(req.method, 'GET');
  assert.equal(url.pathname, '/cart/updatequantity');
  assert.equal(url.searchParams.get('pid'), '123');
  assert.equal(url.searchParams.get('decrease'), 'true');
  assert.equal(url.searchParams.get('fromCart'), 'true');
  assert.equal(url.searchParams.get('csrf_token'), 'tok');
});

test('reserve_delivery_timeslot: optional address fields vanish, fixed fields stay', () => {
  const req = buildRequest(spec('reserve_delivery_timeslot'), {
    shippingMethodId: 'delivery',
    timeslotId: 'slot-1',
    timeslotStart: '2026-10-29T17:00:00.000',
    timeslotEnd: '2026-10-29T21:00:00.000',
    timeslotEco: true,
    storeId: '1234',
    cap: '20121',
    city: 'Milano',
    csrf_token: 'tok',
  });
  const form = req.body as FormData;
  assert.equal(form.get('timeslotEco'), 'true');
  assert.equal(form.get('reorder'), 'false');
  assert.equal(form.get('cartPayload'), 'null');
  assert.equal(form.get('hashText'), '');
  assert.equal(form.has('streetNumber'), false);
  assert.equal(form.get('csrf_token'), 'tok');
});

test('multipart body and URL segment', () => {
  const multipart: ToolSpec = {
    name: 'multipart_fixture',
    description: 'multipart/form-data request with a path parameter',
    request: {
      method: 'POST',
      url: 'https://example.test/stores/{store_id}',
      headers: {},
      query: {},
      body: { insertIds: { $param: 'insert_ids' } },
      content_type: 'multipart/form-data',
    },
  };
  const req = buildRequest(multipart, {
    store_id: '0678',
    insert_ids: ['checkout_top', 'checkout_summary'],
  });
  assert.equal(req.url, 'https://example.test/stores/0678');
  assert.ok(req.body instanceof FormData);
  assert.deepEqual((req.body as FormData).getAll('insertIds'), ['checkout_top', 'checkout_summary']);
  // fetch must generate the multipart boundary itself.
  assert.equal(req.headers['content-type'], undefined);
});

test('missing required path parameter surfaces a clear error', () => {
  const withSegment: ToolSpec = {
    name: 'segment_fixture',
    description: 'GET with a path parameter',
    request: { method: 'GET', url: 'https://example.test/lists/{list_id}' },
  };
  assert.throws(() => buildRequest(withSegment, {}), /Missing required URL path parameter/);
});
