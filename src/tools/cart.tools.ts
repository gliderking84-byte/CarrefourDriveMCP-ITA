import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SFCC_BASE } from '../services/session.service.js';
import { getCsrfToken } from '../services/auth.service.js';
import { MISSING_DELIVERY, SfccError, check, requireSignedIn, sfccHtml, sfccJson, type Json } from '../services/sfcc.service.js';
import { extractCart, textOf, type CartSummary } from '../spec/extract.js';

/**
 * The cart view and the "unavailable products" clean-up.
 *
 * get_cart reads the minicart and the session's delivery selection together, so
 * that a cart with no service or CAP set says so: carrefour.it then refuses to
 * add products (NO_SHIPPING_METHOD_SELECTED) and cannot price the cart for a
 * store, which the minicart alone does not show.
 *
 * remove_unavailable_products is the minicart's "Elimina tutti" button: a POST to
 * Cart-EmptyCartOutOfStock with the CSRF token in the query string and no body,
 * answering JSON with the removed products and the new totals.
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

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export interface DeliverySelection {
  method?: string;
  store_id?: string;
  cap?: string;
  timeslot?: string;
  minutes_left?: number;
  missing?: string;
}

/** The session's delivery choice from Store-ShowTimeslotReserved; `missing` when no service or CAP is set. */
export function parseDeliverySelection(data: Json): DeliverySelection {
  const method = str(data.shippingMethodIdSelected);
  const cap = str(data.shippingSelectedCAP);
  const minutes = Number(data.minutesBeforeTimeslotExpiry);
  const out: DeliverySelection = {
    method,
    store_id: method ? str(data.storeIdSelected) : undefined,
    cap,
    timeslot: str(data.timeslotReserved),
    minutes_left: Number.isFinite(minutes) && data.minutesBeforeTimeslotExpiry !== undefined ? minutes : undefined,
  };
  if (!method || !cap) out.missing = MISSING_DELIVERY;
  else if (!out.timeslot) out.missing = 'No timeslot is reserved: book one with get_delivery_timeslots -> reserve_delivery_timeslot before the checkout.';
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as DeliverySelection;
}

export async function readCart(): Promise<CartSummary> {
  return extractCart(await sfccHtml('GET', `${SFCC_BASE}/Minicart-Show`, { query: { cents: 'false' } }));
}

interface RemovedJson {
  id?: string;
  productName?: string;
  brand?: string;
  qtyincart?: string | number;
  availability?: { messages?: string[] };
}

export function parseRemoved(data: Json): Json {
  const removed = (Array.isArray(data.removedProducts) ? (data.removedProducts as RemovedJson[]) : []).map((p) => {
    const quantity = Number(p.qtyincart);
    return Object.fromEntries(
      Object.entries({
        ean: p.id,
        name: p.productName,
        brand: p.brand ?? undefined,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
        reason: p.availability?.messages?.map(textOf).join('; ') || undefined,
      }).filter(([, v]) => v !== undefined)
    );
  });
  const totals = (data.totals ?? {}) as Json;
  return {
    removed_count: removed.length,
    removed,
    cart_items: data.numItems,
    products_total: totals.subTotal,
    grand_total: totals.grandTotal,
  };
}

export function registerCartTools(server: McpServer): void {
  server.tool(
    'get_cart',
    "Shows the signed-in customer's cart on carrefour.it: each line with EAN, name, brand, price, quantity and " +
      'product URL, the products total, the products NOT available at the selected store/service, the selected ' +
      'service, store, CAP and reserved timeslot, and notices such as the minimum order amount or a missing CAP.',
    {},
    () =>
      run(async () => {
        await requireSignedIn();
        const cart = await readCart();
        const delivery = parseDeliverySelection(
          await sfccJson('GET', `${SFCC_BASE}/Store-ShowTimeslotReserved`).catch(() => ({}) as Json)
        );
        if (delivery.missing) cart.notices.push(delivery.missing);
        return JSON.stringify({ ...cart, delivery }, null, 2);
      })
  );

  server.tool(
    'remove_unavailable_products',
    'Removes from the cart every product that is not available at the selected store/service (the cart\'s ' +
      '"Elimina tutti" under "Prodotti non disponibili") and returns the removed products and the new totals. ' +
      'Products often become unavailable after changing store or service. Tell the user which ones were removed; ' +
      'search_products can find alternatives.',
    {},
    () =>
      run(async () => {
        await requireSignedIn();
        const data = check(
          'Remove unavailable products',
          await sfccJson('POST', `${SFCC_BASE}/Cart-EmptyCartOutOfStock`, {
            query: { csrf_token: await getCsrfToken(), noredirect: 'true' },
          })
        );
        if (data.success !== true) throw new SfccError('carrefour.it did not confirm the removal; check the cart with get_cart.');
        const result = parseRemoved(data);
        if (result.removed_count === 0) return 'The cart has no unavailable products: nothing removed.';
        return JSON.stringify(result, null, 2);
      })
  );
}
