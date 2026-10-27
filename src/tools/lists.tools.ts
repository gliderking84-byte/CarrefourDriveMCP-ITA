import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CARREFOUR_ORIGIN, SFCC_BASE } from '../services/session.service.js';
import { getCsrfToken } from '../services/auth.service.js';
import { SfccError, check, requireSignedIn, sfccHtml, sfccJson } from '../services/sfcc.service.js';
import { decodeEntities, extractCart, parseProduct, textOf, type Product } from '../spec/extract.js';

/**
 * Shopping lists ("lista desideri") and bulk cart operations.
 *
 * Writes follow captured traffic: adding a whole list to the cart is one
 * /cart/add-product call carrying every product in `pidsObj`, and emptying the
 * cart is the Cart-EmptyCart form post. Reading the lists means parsing the
 * /account/wishlist and /wishlist pages, which were not captured: those parsers
 * rely on the markup seen elsewhere on the site (product tiles, wishlist links).
 */

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError };
}

async function run(work: () => Promise<string>) {
  try {
    return text(await work());
  } catch (error) {
    return text((error as Error).message, true);
  }
}

export interface ShoppingList {
  list_id: string;
  name: string;
  count?: number;
}

/** The last heading or title-like element in `html`: a list card's title, "nuova lista MPC (1)". */
function lastTitle(html: string): string | undefined {
  const titles = [
    ...html.matchAll(/<(h[1-6]|p|span|div)\b[^>]*?(?:class="[^"]*(?:title|name)[^"]*")?[^>]*>([^<]{1,120})<\/\1>/g),
  ]
    .filter((m) => m[1].startsWith('h') || /class="[^"]*(?:title|name)/.test(m[0]))
    .map((m) => textOf(m[2]))
    .filter(Boolean);
  return titles.at(-1);
}

/**
 * The lists linked from /account/wishlist: `/wishlist?…id=<list id>…`. Each card's
 * link reads "Vedi la lista", so the name is the card title before the link.
 */
export function parseShoppingLists(html: string): ShoppingList[] {
  const lists = new Map<string, ShoppingList>();
  let previousEnd = 0;
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]*\/wishlist\?[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const id = decodeEntities(m[1]).match(/[?&]id=([0-9a-zA-Z]+)/)?.[1];
    const linkText = textOf(m[2]);
    const generic = !linkText || /^vedi\b/i.test(linkText);
    const label = (generic ? lastTitle(html.slice(previousEnd, m.index)) : linkText) ?? linkText;
    previousEnd = m.index! + m[0].length;
    if (!id || lists.has(id)) continue;
    const counted = label.match(/^(.*?)\s*\((\d+)\)$/);
    lists.set(id, counted ? { list_id: id, name: counted[1], count: Number(counted[2]) } : { list_id: id, name: label });
  }
  return [...lists.values()];
}

/**
 * The products on a /wishlist?id=… page. Each is a `<div class="product tile">`
 * carrying `data-product-json`; the list container's `data-pids` names every EAN
 * in the list, including any the infinite scroll has not rendered yet.
 */
export function parseShoppingListProducts(html: string): Product[] {
  const products = new Map<string, Product>();
  const starts = [...html.matchAll(/<(?:div|article)\s[^>]*?class="product tile/g)].map((m) => m.index!);
  starts.forEach((from, i) => {
    const product = parseProduct(html.slice(from, starts[i + 1] ?? html.length));
    if (product && !products.has(product.ean)) products.set(product.ean, product);
  });

  const listed = html.match(/data-pids="([^"]*)"/)?.[1];
  if (listed) {
    try {
      for (const ean of JSON.parse(decodeEntities(listed)) as unknown[]) {
        const id = String(ean);
        if (!products.has(id)) products.set(id, { ean: id, name: '' });
      }
    } catch {
      // A malformed attribute leaves the rendered tiles.
    }
  }
  return [...products.values()];
}

async function readList(listId: string): Promise<Product[]> {
  return parseShoppingListProducts(
    await sfccHtml('GET', `${CARREFOUR_ORIGIN}/wishlist`, { query: { rurl: '8', id: listId }, page: true })
  );
}

/** Every product in one /cart/add-product call, as the list page's "add all" button does. */
async function addManyToCart(items: Array<{ ean: string; quantity: number }>): Promise<string> {
  const pidsObj = items.map((i) => ({ pid: i.ean, qty: i.quantity, addevenifunavailable: false, iswishlistaddall: true }));
  const data = check(
    'Add to cart',
    await sfccJson('POST', `${CARREFOUR_ORIGIN}/cart/add-product`, {
      form: { pidsObj: JSON.stringify(pidsObj), skipnotifications: 'true', csrf_token: await getCsrfToken() },
    })
  );
  return JSON.stringify(
    { added: items.length, message: data.message, cart_items: data.quantityTotal, cart_total: data.totalPrice },
    null,
    2
  );
}

export function registerListTools(server: McpServer): void {
  server.tool(
    'get_shopping_lists',
    "Lists the signed-in customer's shopping lists (liste desideri) with their list_id.",
    {},
    () =>
      run(async () => {
        await requireSignedIn();
        const lists = parseShoppingLists(await sfccHtml('GET', `${CARREFOUR_ORIGIN}/account/wishlist`, { query: { rurl: '8' }, page: true }));
        if (lists.length === 0) return 'No shopping list found. Create one with create_shopping_list.';
        return JSON.stringify(lists, null, 2);
      })
  );

  server.tool(
    'get_shopping_list',
    'Shows the products in one of the signed-in customer\'s shopping lists: EAN, name, brand, price, unit price and URL.',
    { list_id: z.string().describe('list_id from get_shopping_lists or create_shopping_list.') },
    ({ list_id }) =>
      run(async () => {
        await requireSignedIn();
        const products = await readList(list_id);
        return JSON.stringify({ list_id, count: products.length, products }, null, 2);
      })
  );

  server.tool(
    'add_shopping_list_to_cart',
    'Adds every product of a shopping list to the cart, one unit each, in a single call — like the list\'s ' +
      '"aggiungi tutto al carrello" button. A delivery method must be selected first (reserve_delivery_timeslot).',
    { list_id: z.string().describe('list_id from get_shopping_lists.') },
    ({ list_id }) =>
      run(async () => {
        await requireSignedIn();
        const products = await readList(list_id);
        if (products.length === 0) {
          throw new SfccError('No product found in this list (or its page could not be read), so nothing was added.');
        }
        return addManyToCart(products.map((p) => ({ ean: p.ean, quantity: 1 })));
      })
  );

  server.tool(
    'add_products_to_cart',
    'Adds several products to the cart in one call, each with its quantity. A delivery method must be selected ' +
      'first (reserve_delivery_timeslot).',
    {
      products: z
        .array(z.object({ ean: z.string(), quantity: z.number().int().positive().optional() }))
        .min(1)
        .describe('Products to add: [{ "ean": "8002580010945", "quantity": 2 }, ...]. quantity defaults to 1.'),
    },
    ({ products }) =>
      run(async () => {
        await requireSignedIn();
        return addManyToCart(products.map((p) => ({ ean: p.ean, quantity: p.quantity ?? 1 })));
      })
  );

  server.tool(
    'empty_cart',
    'Removes EVERY product from the signed-in customer\'s cart (Svuota carrello). Ask the user before calling it.',
    { confirm: z.boolean().describe('Must be true: the user asked to empty the cart.') },
    ({ confirm }) =>
      run(async () => {
        if (confirm !== true) throw new SfccError('Not emptied: confirm must be true, once the user asked for it.');
        await requireSignedIn();
        // The site posts the confirmation dialog's form; the answer is a page, so check the cart after.
        await sfccHtml('POST', `${SFCC_BASE}/Cart-EmptyCart`, {
          query: { noredirect: 'true' },
          urlencoded: { csrf_token: await getCsrfToken() },
        });
        const cart = extractCart(await sfccHtml('GET', `${SFCC_BASE}/Minicart-Show`, { query: { cents: 'false' } }));
        if (cart.items.length > 0) {
          throw new SfccError(`The cart still holds ${cart.item_count} item(s) after emptying it.`);
        }
        return 'Cart emptied.';
      })
  );
}
