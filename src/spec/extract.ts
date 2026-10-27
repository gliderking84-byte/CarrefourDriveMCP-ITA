import type { ExtractorName, ResponseSpec } from './types.js';

/**
 * carrefour.it runs on Salesforce Commerce Cloud (SFRA). Its controllers answer
 * either with JSON wrapped in a fixed envelope, or with HTML fragments meant to
 * be dropped into the page. Neither is fit to hand to a model as-is: a single
 * product grid is ~275 kB of markup for 25 products. The extractors below keep
 * the data and drop the rest.
 *
 * They read the `data-*` attributes the storefront's own JS consumes
 * (`data-product-json`, `data-option-product-price`, ...), which are far more
 * stable than the visible markup.
 */

export const SITE_ORIGIN = 'https://www.carrefour.it';

/**
 * Keys every SFCC JSON response carries and nobody needs. `queryString` can hold
 * the CSRF token, and `csrf` is one (Account-AddressBook, Checkout-UpdateTimeslot).
 */
const ENVELOPE_KEYS = new Set([
  'action',
  'csrf',
  'tracking_consent',
  'queryString',
  'locale',
  'nonce',
  'originalUri',
  'minutesBeforeTimeslotExpiry',
  'secondsBeforeTimeslotExpiry',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  euro: '€',
  deg: '°',
  agrave: 'à',
  aacute: 'á',
  egrave: 'è',
  eacute: 'é',
  igrave: 'ì',
  iacute: 'í',
  ograve: 'ò',
  oacute: 'ó',
  ugrave: 'ù',
  uacute: 'ú',
  Agrave: 'À',
  Egrave: 'È',
  Eacute: 'É',
  Igrave: 'Ì',
  Ograve: 'Ò',
  Ugrave: 'Ù',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code] ?? match;
  });
}

/** Strip tags, decode entities, collapse whitespace. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(html: string, name: string): string | undefined {
  const match = html.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : undefined;
}

function jsonAttr<T>(html: string, name: string): T | undefined {
  const raw = attr(html, name);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function absolute(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.startsWith('http') ? path : `${SITE_ORIGIN}${path}`;
}

/** Split `html` into the chunks starting at each match of `start`. */
function chunks(html: string, start: RegExp): string[] {
  const indices: number[] = [];
  const re = new RegExp(start.source, start.flags.includes('g') ? start.flags : `${start.flags}g`);
  for (let m = re.exec(html); m; m = re.exec(html)) indices.push(m.index);
  return indices.map((from, i) => html.slice(from, indices[i + 1] ?? html.length));
}

// --- Products ------------------------------------------------------------------

export interface Product {
  ean: string;
  name: string;
  brand?: string;
  price?: number;
  list_price?: number;
  discount?: string;
  unit_price?: string;
  size?: string;
  category_path?: string;
  tags?: string[];
  quantity_in_cart?: number;
  url?: string;
}

interface ProductJson {
  name?: string;
  id?: string;
  price?: string;
  brand?: string;
  dimension52?: string;
}

interface PriceJson {
  sales?: { value?: number } | null;
  list?: { value?: number } | null;
}

/** One product tile (`<article class="product tile">`) or cart line (`<li class="line-item-card">`). */
export function parseProduct(chunk: string): Product | null {
  const info = jsonAttr<ProductJson>(chunk, 'data-product-json');
  const ean = info?.id ?? attr(chunk, 'data-pid');
  if (!ean) return null;

  const product: Product = { ean, name: info?.name ?? '' };
  if (info?.brand) product.brand = info.brand;

  const price = jsonAttr<PriceJson>(chunk, 'data-option-product-price');
  const sales = price?.sales?.value ?? (info?.price ? Number(info.price) : undefined);
  if (sales !== undefined && Number.isFinite(sales)) product.price = sales;
  if (price?.list?.value !== undefined && price.list.value !== sales) product.list_price = price.list.value;

  const discount = attr(chunk, 'data-option-product-discountPercentage');
  if (discount) product.discount = discount;

  // The screen-reader text is the only place the unit is spelled out: "Prezzo al l: € 2,38."
  const unit = [...chunk.matchAll(/<span class="sr-only">([\s\S]*?)<\/span>/g)]
    .map((m) => textOf(m[1]).match(/Prezzo al ([^:]+):\s*(€\s*[\d.,]*\d)/))
    .find((m) => m !== null);
  if (unit) product.unit_price = `${unit[2]}/${unit[1].trim()}`;

  if (info?.dimension52) product.size = info.dimension52;

  const crumbs = jsonAttr<Array<{ htmlValue?: string }>>(chunk, 'data-option-product-breadcrumbs');
  if (crumbs?.length) {
    product.category_path = crumbs
      .map((c) => decodeEntities(c.htmlValue ?? ''))
      .filter(Boolean)
      .join(' > ');
  }

  const tags = [
    ...chunk.matchAll(/class="lifestyle tooltip"[^>]*>\s*<div class="icon"[^>]*><\/div>\s*<span>([^<]+)<\/span>/g),
  ].map((m) => textOf(m[1]));
  if (tags.length) product.tags = tags;

  // Tiles say -1 for "not in the cart"; cart lines carry the real quantity.
  const quantity = Number(attr(chunk, 'data-option-quantity'));
  if (Number.isFinite(quantity) && quantity > 0) product.quantity_in_cart = quantity;

  product.url = absolute(chunk.match(/href="(\/p\/[^"]+)"/)?.[1]);
  return product;
}

export function extractProductGrid(html: string): {
  count: number;
  products: Product[];
  next_start?: number;
} {
  const products = chunks(html, /<article\b/)
    .map(parseProduct)
    .filter((p): p is Product => p !== null);

  // The "load more" button links to the next page; no button means last page.
  const more = html.match(/class="show-more-infinity"[^>]*page-url="([^"]*)"/)?.[1];
  const nextStart = more ? Number(new URL(decodeEntities(more), SITE_ORIGIN).searchParams.get('start')) : NaN;

  const out: { count: number; products: Product[]; next_start?: number } = { count: products.length, products };
  if (Number.isFinite(nextStart)) out.next_start = nextStart;
  return out;
}

// --- Search suggestions --------------------------------------------------------

export function extractSuggestions(data: unknown): {
  categories: Array<{ name: string; url: string }>;
  products: Array<{ name: string; ean?: string; url: string }>;
  popular_searches: string[];
} {
  const html = typeof data === 'object' && data !== null ? String((data as { result?: unknown }).result ?? '') : String(data);
  const list = (cls: string) => html.match(new RegExp(`<ul class="[^"]*${cls}[^"]*"[\\s\\S]*?</ul>`))?.[0] ?? '';
  const links = (block: string) =>
    [...block.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
      href: decodeEntities(m[1]),
      text: textOf(m[2]),
    }));

  return {
    categories: links(list('search-results-category')).map((l) => ({ name: l.text, url: absolute(l.href)! })),
    products: links(list('search-results-products')).map((l) => ({
      name: l.text,
      ean: l.href.match(/\/(\d{8,14})\.html/)?.[1],
      url: absolute(l.href)!,
    })),
    popular_searches: links(list('popular-suggestions')).map((l) => l.text),
  };
}

// --- Cart ----------------------------------------------------------------------

export function extractCart(html: string): {
  item_count: number;
  total_products?: string;
  shipping?: string;
  notices: string[];
  items: Product[];
} {
  const items = chunks(html, /<li\s+class="line-item-card/)
    .map(parseProduct)
    .filter((p): p is Product => p !== null);

  const total = html.match(/Totale PRODOTTI<\/p>\s*<p class="minicartsidebar-price">([\s\S]*?)<\/p>/)?.[1];
  const shipping = html.match(/<p class="address">([\s\S]*?)<\/p>/)?.[1];
  const notices = [...html.matchAll(/<div class="minimum-order-flag-container">([\s\S]*?)<\/div>/g)].map((m) =>
    textOf(m[1])
  );

  const out: { item_count: number; total_products?: string; shipping?: string; notices: string[]; items: Product[] } =
    {
      item_count: items.reduce((sum, item) => sum + (item.quantity_in_cart ?? 1), 0),
      notices,
      items,
    };
  if (total) out.total_products = textOf(total);
  if (shipping) out.shipping = textOf(shipping);
  return out;
}

// --- Stores --------------------------------------------------------------------

interface StoreJson {
  id?: string;
  name?: string;
  brand?: string;
  address1?: string;
  city?: string;
  postalCode?: string;
  stateCode?: string;
  distance?: number;
}

function store(s: StoreJson | undefined | null) {
  if (!s?.id) return null;
  const out: Record<string, unknown> = {
    store_id: s.id,
    name: s.name,
    brand: s.brand,
    address: [s.address1, s.postalCode, s.city, s.stateCode]
      .map((part) => part?.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(', '),
  };
  if (typeof s.distance === 'number') out.distance_km = Math.round(s.distance * 10) / 10;
  // A pickup reservation is made with the store's own CAP and city.
  if (s.postalCode) out.cap = s.postalCode;
  if (s.city) out.city = s.city;
  return out;
}

export function extractStores(data: unknown): unknown {
  const body = data as {
    request?: unknown;
    services?: Array<{
      shippingMethodId?: string;
      shippingMethodName?: string;
      cap?: string;
      city?: string;
      state?: string;
      store?: StoreJson | null;
      stores?: Array<StoreJson & { store?: StoreJson }>;
    }>;
  };
  if (!Array.isArray(body?.services)) return stripEnvelope(data);

  return {
    request: body.request,
    services: body.services.map((svc) => {
      // Delivery lists `{store: {...}}` wrappers, pickup and drive list stores directly.
      const stores = (svc.stores ?? [])
        .map((s) => store(s.store ?? s))
        .filter((s): s is Record<string, unknown> => s !== null);
      const assigned = store(svc.store);
      if (assigned && !stores.some((s) => s.store_id === assigned.store_id)) stores.unshift(assigned);
      return {
        shipping_method_id: svc.shippingMethodId,
        name: svc.shippingMethodName,
        cap: svc.cap,
        city: svc.city,
        state: svc.state,
        stores,
      };
    }),
  };
}

// --- Timeslots -----------------------------------------------------------------

interface SlotJson {
  slotId?: string;
  startDateTime?: string;
  endDateTime?: string;
  startTime?: string;
  endTime?: string;
  isEco?: boolean;
  isReserved?: boolean;
}

export function extractTimeslots(data: unknown): unknown {
  const body = data as {
    error?: unknown;
    userLogged?: boolean;
    timeslots?: Array<{
      dayOfWeek?: string;
      dayOfMonth?: string;
      month?: string;
      year?: string;
      timeslotsMorning?: SlotJson[];
      timeslotsAfternoon?: SlotJson[];
      timeslotsEvening?: SlotJson[];
    }>;
  };
  if (!Array.isArray(body?.timeslots)) return stripEnvelope(data);

  return {
    user_logged: body.userLogged,
    days: body.timeslots.map((day) => ({
      date: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.dayOfMonth).padStart(2, '0')}`,
      day: day.dayOfWeek,
      slots: [...(day.timeslotsMorning ?? []), ...(day.timeslotsAfternoon ?? []), ...(day.timeslotsEvening ?? [])]
        .map((slot) => ({
          timeslot_id: slot.slotId,
          start: slot.startDateTime,
          end: slot.endDateTime,
          label: `${slot.startTime}-${slot.endTime}`,
          eco: slot.isEco === true,
          reserved: slot.isReserved === true,
        }))
        .sort((a, b) => String(a.start).localeCompare(String(b.start))),
    })),
  };
}

// --- Errors --------------------------------------------------------------------

/**
 * The failure an SFCC answer reports despite its HTTP 200: an `error` code
 * (`NO_SHIPPING_METHOD_SELECTED`), `error: true` with an `errorMessage`, or
 * per-field form errors (`errorFields` / `fieldErrors`). `null` when it succeeded.
 */
export function sfccError(data: unknown): { code?: string; message: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const body = data as Record<string, unknown>;
  if (typeof body.error === 'string' && body.error) return { code: body.error, message: body.error };
  if (body.success === false) {
    const message = [body.msg, body.message, body.errorMessage].find((m) => typeof m === 'string' && m);
    return { message: message ? textOf(message as string) : 'carrefour.it reported a failure' };
  }
  if (body.error === true) {
    const message = typeof body.errorMessage === 'string' ? textOf(body.errorMessage) : 'carrefour.it reported an error';
    return { message };
  }
  for (const key of ['errorFields', 'fieldErrors']) {
    const fields = body[key];
    if (fields && typeof fields === 'object' && Object.keys(fields).length > 0) {
      const messages = Object.entries(fields as Record<string, unknown>).map(([field, msg]) => `${field}: ${textOf(String(msg))}`);
      return { message: messages.join('; ') };
    }
  }
  return null;
}

// --- Generic JSON --------------------------------------------------------------

export function stripEnvelope(data: unknown, pick?: string[]): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    if (pick && !pick.includes(key)) continue;
    // Some fields are rendered markup ("Ven 30<span>, </span>12:00 - 16:00").
    out[key] = typeof value === 'string' && /<[a-z/]/i.test(value) ? textOf(value) : value;
  }
  return out;
}

const EXTRACTORS: Record<ExtractorName, (data: unknown, spec: ResponseSpec) => unknown> = {
  json: (data, spec) => stripEnvelope(data, spec.pick),
  product_grid: (data) => extractProductGrid(String(data)),
  suggestions: (data) => extractSuggestions(data),
  cart: (data) => extractCart(String(data)),
  stores: (data) => extractStores(data),
  timeslots: (data) => extractTimeslots(data),
};

export function isExtractorName(name: unknown): name is ExtractorName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(EXTRACTORS, name);
}

/** Apply a tool's response spec. HTML errors pages and other surprises pass through untouched. */
export function extract(data: unknown, spec: ResponseSpec = {}): unknown {
  return EXTRACTORS[spec.extract ?? 'json'](data, spec);
}
