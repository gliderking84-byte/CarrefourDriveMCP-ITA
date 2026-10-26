import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEntities,
  extract,
  extractCart,
  extractProductGrid,
  extractStores,
  extractSuggestions,
  extractTimeslots,
  stripEnvelope,
} from '../spec/extract.js';

// Trimmed-down copies of the markup carrefour.it serves, with made-up values.

const q = (value: unknown) => JSON.stringify(value).replace(/"/g, '&quot;');

function tile(opts: { ean: string; name: string; price: number; list?: number; discount?: string; tag?: string }) {
  return `
<div style="height: 100%;">
  <article
    class="product tile product-item-with-tooltip   "
    data-pid="${opts.ean}" data-product-json="${q({ name: opts.name, id: opts.ean, price: String(opts.price), brand: 'Marca', category: 'latte_uht', dimension52: '1000.0 ml', dimension53: 'food' })}"
    data-component="productTileComponent"
    data-option-product-promotion-info="{}"
    data-option-product-price="${q({ sales: { value: opts.price, currency: 'EUR' }, list: opts.list ? { value: opts.list } : null })}"
    data-option-product-breadcrumbs="${q([{ htmlValue: 'Spesa Online' }, { htmlValue: 'Uova, latte e latticini' }, { htmlValue: 'Latte' }])}"
    data-option-product-discountPercentage="${opts.discount ?? ''}" data-option-iscategory="true">
  <h3><a href="/p/prodotto/${opts.ean}.html" class="tile-link-pdp"><span class="brand">Marca</span>${opts.name}</a></h3>
  ${
    opts.tag
      ? `<div class="lifestyles-icon"><div class="lifestyle tooltip" data-component="tooltipComponent" tabindex="0">
          <div class="icon" style="background-image: url(x.svg)"></div>
          <span>${opts.tag}</span>
        </div></div>`
      : '<div class="lifestyles-icon"></div>'
  }
  <span class="sales ">
    <span class="sr-only">
      "Prezzo al l: &euro; ${String(opts.price).replace('.', ',')}.
      Peso confezione: 1000.0 ml.
    </span>
  </span>
  <div class="add-to-cart" data-option-pid="${opts.ean}" data-option-quantity="-1.0">
    <button class="btn btn-primary js-add-to-cart"><span>Aggiungi</span></button>
  </div>
  </article>
</div>`;
}

test('decodeEntities handles named, decimal and hex entities', () => {
  assert.equal(decodeEntities('Digeribilit&agrave; &euro; 1,19 &#39;x&#39; &#x2019;'), "Digeribilità € 1,19 'x' ’");
  assert.equal(decodeEntities('&unknown; stays'), '&unknown; stays');
});

test('product grid: one product per tile, prices, discount, tags and next page', () => {
  const html =
    tile({ ean: '111', name: 'Latte Intero 1 L', price: 1.35 }) +
    tile({ ean: '222', name: 'Latte Bont&agrave; 1 L', price: 1.75, list: 1.99, discount: '12%', tag: 'Senza lattosio' }) +
    '<div class="show-more-infinity" page-url="https://www.carrefour.it/spesa-online/latte/?pmin=0%2C01&amp;start=50&amp;sz=25" data-component="loadMoreComponent"></div>';

  const grid = extractProductGrid(html);
  assert.equal(grid.count, 2);
  assert.equal(grid.next_start, 50);

  const [plain, promo] = grid.products;
  assert.deepEqual(plain, {
    ean: '111',
    name: 'Latte Intero 1 L',
    brand: 'Marca',
    price: 1.35,
    unit_price: '€ 1,35/l',
    size: '1000.0 ml',
    category_path: 'Spesa Online > Uova, latte e latticini > Latte',
    url: 'https://www.carrefour.it/p/prodotto/111.html',
  });
  assert.equal(promo.name, 'Latte Bontà 1 L');
  assert.equal(promo.list_price, 1.99);
  assert.equal(promo.discount, '12%');
  assert.deepEqual(promo.tags, ['Senza lattosio']);
  assert.equal(promo.quantity_in_cart, undefined, 'a tile quantity of -1 means "not in the cart"');
});

test('product grid: no load-more button means last page', () => {
  assert.equal(extractProductGrid(tile({ ean: '1', name: 'x', price: 1 })).next_start, undefined);
  assert.deepEqual(extractProductGrid('<html>nothing here</html>'), { count: 0, products: [] });
});

test('cart: lines with quantities, total, delivery place and notices', () => {
  const line = (ean: string, qty: number) => `
<li
class="line-item-card    uuid-abc pid-${ean}       " >
<div class="card " data-component="cartItemComponent"
data-option-product-price="${q({ sales: { value: 1.19 }, list: null })}"
data-product-json="${q({ name: 'Latte 500 ml', id: ean, price: '1.19', brand: 'Marca' })}">
<a class="product-link" href="/p/latte/${ean}.html"></a>
<div class="add-to-cart show-quantity " data-option-pid="${ean}" data-option-quantity="${qty}"></div>
</div>
</li>`;
  const html = `
<div class="cart-shipping-banner pointer"><p class="address">
<span class="label"><span class="cart-address-service">Consegna a casa</span></span>
<span class="to-bold">Milano, 20121</span></p></div>
<div class="minimum-order-flag"><div class="minimum-order-flag-container">
<i class="icon-warning-cart"></i>
<p>Per completare l’ordine è necessario raggiungere <b>almeno 35€ di Spesa Online</b></p>
</div></div>
<ul>${line('111', 2)}${line('222', 1)}</ul>
<p>Totale PRODOTTI</p>
<p class="minicartsidebar-price">&euro; 3,57</p>`;

  const cart = extractCart(html);
  assert.equal(cart.item_count, 3);
  assert.equal(cart.total_products, '€ 3,57');
  assert.equal(cart.shipping, 'Consegna a casa Milano, 20121');
  assert.deepEqual(cart.notices, ['Per completare l’ordine è necessario raggiungere almeno 35€ di Spesa Online']);
  assert.deepEqual(
    cart.items.map((i) => [i.ean, i.quantity_in_cart]),
    [
      ['111', 2],
      ['222', 1],
    ]
  );
});

test('suggestions: categories, products with EAN, and popular searches', () => {
  const result = `<div class="suggestions"><div id="search-results">
    <ul class="search-results-category" role="listbox">
      <li><a href="/spesa-online/uova-latte-e-latticini/latte/"><strong>Latte</strong></a></li>
    </ul>
    <ul class="search-results-products" role="listbox">
      <li><a href="/p/latte-intero/8000000000001.html" aria-label="Latte">Latte <strong>intero</strong> 1 L</a></li>
    </ul></div></div>`;
  assert.deepEqual(extractSuggestions({ action: 'SearchRouter-Suggestions', success: true, result }), {
    categories: [{ name: 'Latte', url: 'https://www.carrefour.it/spesa-online/uova-latte-e-latticini/latte/' }],
    products: [
      { name: 'Latte intero 1 L', ean: '8000000000001', url: 'https://www.carrefour.it/p/latte-intero/8000000000001.html' },
    ],
    popular_searches: [],
  });

  const popular = `<ul class="search-results-recent popular-suggestions"><span>Prodotti pi&ugrave; cercati</span>
    <li><a href="/on/demandware.store/Sites-carrefour-IT-Site/it_IT/FactFinder-Search?q=tonno">tonno</a></li></ul>`;
  assert.deepEqual(extractSuggestions({ result: popular }).popular_searches, ['tonno']);
});

test('stores: delivery wrappers and pickup lists flatten to the same shape', () => {
  const out = extractStores({
    action: 'Store-Search',
    request: { cap: '20121', city: 'Milano' },
    services: [
      {
        shippingMethodId: 'delivery',
        shippingMethodName: 'Consegna a casa',
        cap: '20121',
        city: 'Milano',
        state: 'MI',
        store: { id: '9001', name: 'Carrefour Iper', address1: 'Via  Uno 1', city: 'MILANO', postalCode: '20100', stateCode: 'MI' },
        stores: [{ store: { id: '9001', name: 'Carrefour Iper', address1: 'Via  Uno 1', city: 'MILANO' } }],
      },
      {
        shippingMethodId: 'pickup_in_store',
        shippingMethodName: 'Ritiro in negozio',
        store: null,
        stores: [{ id: '9002', name: 'Carrefour Express', address1: 'Via Due 2', city: 'MILANO', distance: 1.234 }],
      },
    ],
  }) as { services: Array<{ shipping_method_id: string; stores: Array<Record<string, unknown>> }> };

  assert.equal(out.services[0].stores.length, 1, 'the assigned delivery store is not listed twice');
  assert.equal(out.services[0].stores[0].store_id, '9001');
  assert.equal(out.services[0].stores[0].address, 'Via Uno 1, MILANO');
  assert.deepEqual(out.services[1].stores[0], {
    store_id: '9002',
    name: 'Carrefour Express',
    brand: undefined,
    address: 'Via Due 2, MILANO',
    distance_km: 1.2,
  });
});

test('timeslots: day parts merge into one sorted list per day', () => {
  const slot = (id: string, start: string, end: string, eco = false) => ({
    slotId: id,
    startDateTime: `2026-10-28T${start}:00.000`,
    endDateTime: `2026-10-28T${end}:00.000`,
    startTime: start,
    endTime: end,
    isEco: eco,
    isReserved: false,
  });
  const out = extractTimeslots({
    userLogged: true,
    timeslotsTemplate: '<div>huge</div>',
    timeslots: [
      {
        dayOfWeek: 'Mer',
        dayOfMonth: '28',
        month: '10',
        year: '2026',
        timeslotsMorning: [slot('b', '12:00', '16:00', true), slot('a', '12:00', '14:00')],
        timeslotsAfternoon: [],
        timeslotsEvening: [slot('c', '19:00', '22:00')],
      },
    ],
  }) as { user_logged: boolean; days: Array<{ date: string; slots: Array<{ timeslot_id: string; label: string; eco: boolean }> }> };

  assert.equal(out.user_logged, true);
  assert.equal(out.days[0].date, '2026-10-28');
  assert.deepEqual(
    out.days[0].slots.map((s) => [s.timeslot_id, s.label, s.eco]),
    [
      ['b', '12:00-16:00', true],
      ['a', '12:00-14:00', false],
      ['c', '19:00-22:00', false],
    ]
  );
});

test('JSON responses lose the SFCC envelope, including a queryString carrying the CSRF token', () => {
  const body = {
    action: 'Cart-UpdateQuantity',
    queryString: 'csrf_token=SECRET&pid=1',
    originalUri: 'https://www.carrefour.it/...csrf_token%3dSECRET',
    nonce: 'n',
    locale: 'it_IT',
    numItems: 2,
    totalPrice: '€ 2,38',
    timeslotReserved: 'Ven 30<span class="month-slot-mb">, </span><span> ott, </span>12:00 - 16:00',
  };
  const out = stripEnvelope(body) as Record<string, unknown>;
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
  assert.equal(out.numItems, 2);
  assert.equal(out.timeslotReserved, 'Ven 30 , ott, 12:00 - 16:00');

  assert.deepEqual(extract(body, { pick: ['numItems'] }), { numItems: 2 });
});

test('unexpected payloads pass through rather than throwing', () => {
  assert.equal(extract('<html>Cloudflare</html>'), '<html>Cloudflare</html>');
  assert.deepEqual(extract({ error: true, message: 'x' }, { extract: 'timeslots' }), { error: true, message: 'x' });
});
