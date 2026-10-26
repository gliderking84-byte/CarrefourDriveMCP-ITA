import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CARREFOUR_ORIGIN, SFCC_BASE, sessionService, NO_SESSION_MESSAGE } from '../services/session.service.js';
import { getCsrfToken, isLoggedIn } from '../services/auth.service.js';
import { httpService } from '../services/http.service.js';
import { browserService } from '../services/browser.service.js';
import { openInUserBrowser } from '../services/browser-login.js';
import { sfccError, stripEnvelope, textOf } from '../spec/extract.js';
import { logger } from '../utils/logger.js';

/**
 * Checkout on carrefour.it, as captured from a real order:
 *
 *   TimeSlotApi-ReserveTimeSlot      -> shipment UUID
 *   GET /checkout/begin              -> sets the checkout up (and bounces to /cart on a problem)
 *   POST /checkout/shipping-submit   -> delivery address; answers with the basket totals
 *   CheckoutShippingServices-ValidateShippingAddress
 *   Checkout-UpdateTimeslot          -> the slot on the shipment
 *   POST /checkout/payment           -> CREATES THE ORDER, answers with the payment page URL
 *
 * Payment itself happens on Market Pay's hosted page and then PayPal (sign-in,
 * hCaptcha) or the card issuer (3-D Secure): strong customer authentication a
 * human must complete, so the last step opens that page in the user's browser.
 *
 * These calls chain values from one answer into the next, which the one-request
 * JSON tool definitions cannot express, hence code.
 */

const XHR = { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' };
/** place_order only follows a prepare_checkout this recent. */
const PREPARED_TTL_MS = 30 * 60_000;
/** Payment methods seen in real traffic. Others exist on the site but were not captured. */
const PAYMENT_METHODS = ['MP_PAYPAL'] as const;

type Json = Record<string, unknown>;

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError };
}

class CheckoutError extends Error {}

async function call(
  method: 'GET' | 'POST',
  url: string,
  opts: { form?: Record<string, string>; query?: Record<string, string> } = {}
): Promise<Json> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) target.searchParams.set(k, v);
  let body: FormData | undefined;
  if (opts.form) {
    body = new FormData();
    for (const [k, v] of Object.entries(opts.form)) body.append(k, v);
  }
  const result = await httpService.send({ method, url: target.toString(), headers: { ...XHR }, body });
  if (!result.ok) throw new CheckoutError(`HTTP ${result.status} on ${target.pathname}`);
  if (typeof result.data !== 'object' || result.data === null) {
    throw new CheckoutError(`${target.pathname} did not answer with JSON — the session may have expired.`);
  }
  return result.data as Json;
}

/** Throw the SFCC-reported failure of `step`, if any. */
function check(step: string, data: Json): Json {
  const failure = sfccError(data);
  if (failure) throw new CheckoutError(`${step}: ${failure.message}`);
  return data;
}

async function requireSignedIn(): Promise<void> {
  if (!sessionService.hasSession()) throw new CheckoutError(NO_SESSION_MESSAGE);
  if ((await isLoggedIn()) === false) {
    throw new CheckoutError(`carrefour.it no longer sees you as signed in.\n\n${NO_SESSION_MESSAGE}`);
  }
}

// --- Address book --------------------------------------------------------------

export interface SavedAddress {
  customerAddressUUID: string;
  firstName?: string;
  lastName?: string;
  address1?: string;
  houseNumber?: string;
  city?: string;
  stateCode?: string;
  postalCode?: string;
  floor?: string;
  stairs?: string | null;
  hasLift?: string;
  intercomName?: string;
  phone?: string;
  country?: string;
}

async function addressBook(): Promise<SavedAddress[]> {
  const data = check('Account-AddressBook', await call('GET', `${SFCC_BASE}/Account-AddressBook`));
  return Array.isArray(data.addressList) ? (data.addressList as SavedAddress[]) : [];
}

export function describeAddress(a: SavedAddress): string {
  return [
    `${a.address1 ?? ''} ${a.houseNumber ?? ''}`.trim(),
    `${a.postalCode ?? ''} ${a.city ?? ''} (${a.stateCode ?? ''})`.trim(),
    a.floor ? `piano ${a.floor}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Address fields as /checkout/shipping-submit expects them. */
export function shippingForm(a: SavedAddress, phonePrefix: string): Record<string, string> {
  const f = (name: string, value: string | null | undefined) => [
    `dwfrm_shipping_shippingAddress_addressFields_${name}`,
    value ?? '',
  ];
  return Object.fromEntries([
    f('country', a.country || 'IT'),
    f('customerAddressUUID', a.customerAddressUUID),
    f('firstName', a.firstName),
    f('lastName', a.lastName),
    f('address1', a.address1),
    f('houseNumber', a.houseNumber),
    f('city', a.city),
    f('stateCode', a.stateCode),
    f('postalCode', a.postalCode),
    f('floor', a.floor),
    f('stairs', a.stairs),
    f('hasLift', a.hasLift),
    f('intercomName', a.intercomName),
    f('phone', a.phone),
    f('phonePrefix', phonePrefix),
  ]);
}

// --- Order summary -------------------------------------------------------------

interface OrderJson {
  totals?: Record<string, unknown>;
  items?: { totalQuantity?: number; items?: Array<Json> };
}

export function summarizeOrder(order: OrderJson | undefined): Json {
  const totals = order?.totals ?? {};
  return {
    products_total: totals.subTotal,
    delivery_cost: totals.totalShippingCost,
    discounts: (totals.orderLevelDiscountTotal as { formatted?: string } | undefined)?.formatted,
    total_to_pay: totals.grandTotal,
    item_count: order?.items?.totalQuantity,
    items: (order?.items?.items ?? []).map((item) => ({
      ean: item.id,
      name: item.productName,
      quantity: item.qtyincart,
      line_total: (item.priceTotal as { priceValue?: number } | undefined)?.priceValue,
      available: item.available,
    })),
  };
}

let prepared: { at: number; total: unknown; address: string; timeslot: string } | null = null;

/** Exposed for tests. */
export function resetPreparedCheckout(): void {
  prepared = null;
}

// --- Tools ---------------------------------------------------------------------

export function registerCheckoutTools(server: McpServer): void {
  server.tool(
    'get_addresses',
    "Lists the delivery addresses saved in the signed-in customer's carrefour.it account, with the address_id prepare_checkout takes.",
    {},
    async () => {
      try {
        await requireSignedIn();
        const list = await addressBook();
        if (list.length === 0) return text('No saved address. Add one on carrefour.it (Il mio account > Indirizzi).');
        return text(
          JSON.stringify(
            list.map((a) => ({
              address_id: a.customerAddressUUID,
              name: `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim(),
              address: describeAddress(a),
              cap: a.postalCode,
              city: a.city,
              state: a.stateCode,
            })),
            null,
            2
          )
        );
      } catch (error) {
        return text((error as Error).message, true);
      }
    }
  );

  server.tool(
    'apply_coupon',
    'Applies a discount code (codice sconto) to the signed-in customer\'s cart. Returns an error when carrefour.it does not recognise it.',
    { code: z.string().describe('The discount code.') },
    async ({ code }) => {
      try {
        await requireSignedIn();
        const data = check(
          'Coupon',
          await call('POST', `${SFCC_BASE}/CheckoutServices-AddCoupon`, {
            form: { csrf_token: await getCsrfToken(), couponCode: code },
          })
        );
        return text(JSON.stringify(stripEnvelope(data), null, 2));
      } catch (error) {
        return text((error as Error).message, true);
      }
    }
  );

  server.tool(
    'prepare_checkout',
    'Prepares a home-delivery order WITHOUT placing it: reserves the timeslot, sets the saved delivery address and ' +
      'checks it matches the delivery CAP, then returns the order summary — items, delivery cost and total to pay. ' +
      'Show that summary to the user and get their explicit approval before calling place_order. ' +
      'Take the timeslot values from get_delivery_timeslots and the store from find_stores.',
    {
      timeslotId: z.string().describe('timeslot_id from get_delivery_timeslots.'),
      timeslotStart: z.string().describe('start from get_delivery_timeslots, unchanged.'),
      timeslotEnd: z.string().describe('end from get_delivery_timeslots, unchanged.'),
      timeslotEco: z.boolean().describe('eco flag from get_delivery_timeslots.'),
      storeId: z.string().describe('Delivering store ID, from find_stores (delivery).'),
      address_id: z
        .string()
        .optional()
        .describe('address_id from get_addresses. May be left out when the account has a single address.'),
      floor: z.string().optional().describe('Override the saved floor.'),
      intercomName: z.string().optional().describe('Override the name on the intercom.'),
      phone: z.string().optional().describe('Override the contact phone (without prefix).'),
      phonePrefix: z.string().optional().describe("Phone prefix, default '+39'."),
    },
    async (args) => {
      try {
        await requireSignedIn();
        prepared = null;

        const book = await addressBook();
        const address = args.address_id
          ? book.find((a) => a.customerAddressUUID === args.address_id)
          : book.length === 1
            ? book[0]
            : undefined;
        if (!address) {
          throw new CheckoutError(
            book.length === 0
              ? 'No saved address. Add one on carrefour.it first.'
              : 'Pick an address: pass address_id from get_addresses.'
          );
        }
        const chosen: SavedAddress = {
          ...address,
          ...(args.floor !== undefined ? { floor: args.floor } : {}),
          ...(args.intercomName !== undefined ? { intercomName: args.intercomName } : {}),
          ...(args.phone !== undefined ? { phone: args.phone } : {}),
        };

        // 1. The reservation ties the slot to the cart and names the shipment.
        const reservation = check(
          'Timeslot reservation',
          await call('POST', `${SFCC_BASE}/TimeSlotApi-ReserveTimeSlot`, {
            form: {
              shippingMethodId: 'delivery',
              timeslotId: args.timeslotId,
              timeslotStart: args.timeslotStart,
              timeslotEnd: args.timeslotEnd,
              timeslotEco: String(args.timeslotEco),
              storeId: args.storeId,
              hashText: '',
              cartPayload: 'null',
              reorder: 'false',
              redirectParams: 'null',
              csrf_token: await getCsrfToken(),
              city: chosen.city ?? '',
              cap: chosen.postalCode ?? '',
              // The site leaves these empty: the address is set at shipping-submit.
              address: '',
              state: chosen.stateCode ?? '',
              streetNumber: '',
            },
          })
        );
        const shipmentUUID = (reservation.reservedTimeslot as { shipmentUUID?: string } | undefined)?.shipmentUUID;
        if (!shipmentUUID) throw new CheckoutError('The timeslot reservation did not return a shipment.');

        // 2. Open the checkout like the site does; it bounces to /cart when something is off.
        const begin = await browserService.visit(`${CARREFOUR_ORIGIN}/checkout/begin?cart=1&rurl=2`);
        const landed = new URL(begin.finalUrl);
        if (!landed.pathname.startsWith('/checkout')) {
          throw new CheckoutError(
            `carrefour.it refused to open the checkout and sent back to ${landed.pathname}${landed.search}. ` +
              'Check the cart (minimum order, unavailable products) and that the delivery CAP matches the address.'
          );
        }

        // 3. Delivery address.
        const shipping = check(
          'Delivery address',
          await call('POST', `${CARREFOUR_ORIGIN}/checkout/shipping-submit`, {
            form: {
              isOnlyPickupInStore: 'false',
              csrf_token: await getCsrfToken(),
              originalShipmentUUID: shipmentUUID,
              shipmentUUID,
              ...shippingForm(chosen, args.phonePrefix ?? '+39'),
              shippingPhonePrefix: args.phonePrefix ?? '+39',
            },
          })
        );
        check('Address check', await call('GET', `${SFCC_BASE}/CheckoutShippingServices-ValidateShippingAddress`));

        // 4. The slot on the shipment.
        const slot = check(
          'Timeslot',
          await call('POST', `${SFCC_BASE}/Checkout-UpdateTimeslot`, {
            form: {
              uuid: shipmentUUID,
              timeslotId: args.timeslotId,
              timeslotStart: args.timeslotStart,
              timeslotEnd: args.timeslotEnd,
              timeslotEco: String(args.timeslotEco),
              timeslotEnabled: 'true',
            },
          })
        );

        const summary = summarizeOrder(shipping.order as OrderJson | undefined);
        const timeslot = typeof slot.timeslotDateFormatted === 'string' ? textOf(slot.timeslotDateFormatted) : '';
        prepared = { at: Date.now(), total: summary.total_to_pay, address: describeAddress(chosen), timeslot };

        return text(
          JSON.stringify({ status: 'ready — NOT ordered yet', address: prepared.address, timeslot, ...summary }, null, 2) +
            '\n\nNothing is ordered yet. Show this summary to the user; only once they explicitly approve it, call ' +
            'place_order with confirm=true. The timeslot reservation expires 45 minutes after it was made.'
        );
      } catch (error) {
        logger.error('prepare_checkout failed', { error: String(error) });
        return text(`Checkout not prepared — ${(error as Error).message}`, true);
      }
    }
  );

  server.tool(
    'place_order',
    'PLACES THE ORDER prepared by prepare_checkout and opens the payment page in the user\'s browser, where they ' +
      'pay themselves (PayPal sign-in / card 3-D Secure cannot be automated). Creates a real order on carrefour.it: ' +
      'call it only after the user has seen the prepare_checkout summary and explicitly said to go ahead.',
    {
      confirm: z.boolean().describe('Must be true: the user explicitly approved the summary from prepare_checkout.'),
      payment_method: z
        .enum(PAYMENT_METHODS)
        .optional()
        .describe("Payment method. Only 'MP_PAYPAL' (PayPal) is supported so far."),
      order_notes: z.string().optional().describe('Notes for the order (e.g. delivery instructions).'),
    },
    async ({ confirm, payment_method, order_notes }) => {
      if (confirm !== true) {
        return text('Not placed: confirm must be true, and only after the user approved the prepare_checkout summary.', true);
      }
      if (!prepared || Date.now() - prepared.at > PREPARED_TTL_MS) {
        return text('Not placed: run prepare_checkout first (within the last 30 minutes) and show its summary to the user.', true);
      }
      try {
        await requireSignedIn();
        const data = check(
          'Order',
          await call('POST', `${CARREFOUR_ORIGIN}/checkout/payment`, {
            form: {
              paymentOptions: payment_method ?? 'MP_PAYPAL',
              billingAddressEnabled: 'false',
              orderNotes: order_notes ?? '',
              csrf_token: await getCsrfToken(),
              timeslotEnabled: 'true',
            },
          })
        );
        const redirectUrl = typeof data.redirectUrl === 'string' ? data.redirectUrl : '';
        if (!redirectUrl) throw new CheckoutError('carrefour.it did not return a payment page.');
        const orderNumber = new URL(redirectUrl).searchParams.get('orderNumber') ?? 'unknown';
        const placed = prepared;
        prepared = null;

        const window = openInUserBrowser(redirectUrl);
        logger.info('Order placed, payment page handed to the user', { orderNumber, browser: window.browser });
        return text(
          [
            `Order ${orderNumber} created on carrefour.it — total ${String(placed.total)}, delivery ${placed.timeslot} to ${placed.address}.`,
            '',
            window.opened
              ? `The payment page is open in ${window.browser}. Complete the payment there (PayPal sign-in and checks).`
              : `Could not open a browser (${window.error}). Open this link to pay:`,
            redirectUrl,
            '',
            'The order is only confirmed once paid. Check it afterwards in Il mio account > Ordini on carrefour.it.',
          ].join('\n')
        );
      } catch (error) {
        logger.error('place_order failed', { error: String(error) });
        return text(`Order not placed — ${(error as Error).message}`, true);
      }
    }
  );
}
