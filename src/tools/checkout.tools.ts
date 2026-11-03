import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CARREFOUR_ORIGIN, SFCC_BASE } from '../services/session.service.js';
import { getCsrfToken } from '../services/auth.service.js';
import { browserService } from '../services/browser.service.js';
import { openInUserBrowser } from '../services/browser-login.js';
import { SfccError, check, requireSignedIn, saveDebugPage, sfccHtml, sfccJson, type Json } from '../services/sfcc.service.js';
import { extractCart, stripEnvelope, textOf } from '../spec/extract.js';
import { logger } from '../utils/logger.js';

// Where carrefour.it's cart page shows what blocks the checkout.
const CART_ALERTS =
  '[role="alert"], .alert, .alert-danger, .alert-warning, .cart-error, .error-message, .invalid-feedback, ' +
  '.minimum-order-flag-container, .unavailable, .not-available, .product-unavailable, ' +
  '[class*="error"], [class*="warning"], [class*="notice"], [class*="unavailable"], [class*="esaurit"], [class*="limit"]';
const PAYPAL_REDIRECT_TIMEOUT_MS = parseInt(process.env.PAYPAL_REDIRECT_TIMEOUT_MS || '20000', 10);

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

/** place_order only follows a prepare_checkout this recent. */
const PREPARED_TTL_MS = 30 * 60_000;
/**
 * Payment methods of the checkout's "Metodi di pagamento" list, as captured:
 * MP_PAYPAL (PayPal) and MARKETPAY (Mastercard, Visa or American Express on
 * Market Pay's hosted page). Meal vouchers, gift cards and Payback points are
 * applied before this step on the site and are not supported here.
 */
const PAYMENT_METHODS = ['MP_PAYPAL', 'MARKETPAY'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError };
}

/**
 * Where to pay, for a program rather than a person: a PWA opens `payment_url`
 * itself instead of finding the link in the text. Sent as MCP structured
 * content and, for clients that only pass text on (the Claude API's MCP
 * connector), repeated as JSON in a second text block.
 */
export interface PaymentBlock {
  order_number: string;
  payment_method: PaymentMethod;
  /** Open this: Market Pay's card page, PayPal, or Market Pay's page with PayPal. */
  payment_url: string;
  provider: 'market_pay_card' | 'paypal' | 'market_pay' | 'carrefour';
  /** The carrefour.it payment page, for renew_payment_link after a restart. */
  carrefour_payment_page?: string;
  total?: string;
  /** Hours the link stays valid, when known (PayPal: 3). */
  expires_in_hours?: number;
  /**
   * Card only, when it could be checked: whether the link opened on its own shows the card form.
   * false: the form only shows inside carrefour.it — offer the server's screen (desk) or PayPal.
   */
  link_shows_card_form?: boolean;
  /** Tool that tells whether the order got paid. */
  check_with: 'get_order_status';
}

function paymentResult(body: string, payment: PaymentBlock) {
  const block = Object.fromEntries(Object.entries(payment).filter(([, v]) => v !== undefined && v !== '')) as Record<string, unknown>;
  return {
    content: [
      { type: 'text' as const, text: body },
      { type: 'text' as const, text: JSON.stringify({ payment: block }) },
    ],
    structuredContent: { payment: block },
    isError: false,
  };
}

function providerOf(url: string): PaymentBlock['provider'] {
  if (PAYPAL_URL.test(url)) return 'paypal';
  return OFF_CARREFOUR.test(url) ? 'market_pay' : 'carrefour';
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
  const data = check('Account-AddressBook', await sfccJson('GET', `${SFCC_BASE}/Account-AddressBook`));
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

/** carrefour.it payment page of each order placed here (orderNumber → URL), for renew_payment_link. */
const paymentPages = new Map<string, string>();
/** How each order placed here is paid, so a renewed link leads to the same method. */
const paymentMethods = new Map<string, PaymentMethod>();
const PAYPAL_URL = /^https:\/\/([a-z0-9-]+\.)*paypal\.com\//i;
/** Any https page outside carrefour.it: the payment provider's page (Market Pay, then PayPal). */
const OFF_CARREFOUR = /^https:\/\/(?!(?:[a-z0-9-]+\.)*carrefour\.it(?:[/:?#]|$))[^\s]+/i;

/**
 * The carrefour.it payment page (…/PayOnline-Checkout?seu=…&orderNumber=…) only works with the
 * customer's carrefour.it session: on a phone without it, it is a 404. The provider's hosted page
 * it forwards to (in `seu`) carries its own token and works on any device.
 */
export function providerPageOf(redirectUrl: string): string {
  try {
    const seu = new URL(redirectUrl).searchParams.get('seu') ?? '';
    return OFF_CARREFOUR.test(seu) ? seu : '';
  } catch {
    return '';
  }
}

/**
 * The provider's page (Market Pay) asks the user to press "Paga" before PayPal opens: pressed here,
 * in a throwaway tab, the user gets PayPal's own page straight away (and, on a phone, the PayPal app
 * when it is installed). '' when it cannot be reached: the provider's page stays the link.
 */
async function payPalBehind(provider: string): Promise<string> {
  if (!provider || PAYPAL_URL.test(provider)) return provider;
  try {
    return await browserService.payPalFromProvider(provider, PAYPAL_URL, PAYPAL_REDIRECT_TIMEOUT_MS + 10000);
  } catch (error) {
    logger.info('PayPal not reached from the payment page', { error: String(error) });
    return '';
  }
}

/**
 * Market Pay's card page exactly as carrefour.it shows it (the URL the order's payment page leaves
 * for, or its iframe), with how many card fields it renders there and opened on its own.
 */
async function cardPage(page: string): Promise<{ url: string; fields: number; standaloneFields: number }> {
  try {
    return await browserService.cardPageFrom(page, OFF_CARREFOUR, PAYPAL_REDIRECT_TIMEOUT_MS + 10000);
  } catch (error) {
    logger.info('Card payment page not reached', { error: String(error) });
    return { url: '', fields: 0, standaloneFields: 0 };
  }
}
/** When the card fields only show inside carrefour.it, the link alone will not let the user pay. */
function cardWarning(card: { url: string; fields: number; standaloneFields: number }): string[] {
  if (!card.url || card.standaloneFields > 0) return [];
  return [
    card.fields > 0
      ? 'Warning: Market Pay shows the card fields only inside the carrefour.it page, not when this link is opened on its own (CARD_FIELDS_ONLY_ON_CARREFOUR). Pay from the server\'s screen or choose PayPal.'
      : 'Warning: no card fields were found on the card page (CARD_FIELDS_NOT_FOUND). If the page shows no card form, pay from the server\'s screen or choose PayPal.',
    '',
  ];
}

/** The link to hand the user: PayPal (also behind the provider's page), else the provider's page, else `seu`. */
async function paymentLinkFrom(page: string): Promise<{ url: string; paypal: boolean }> {
  let provider = '';
  try {
    provider = await browserService.followRedirect(page, OFF_CARREFOUR, PAYPAL_REDIRECT_TIMEOUT_MS);
  } catch (error) {
    logger.info('The payment page did not leave carrefour.it', { error: String(error) });
  }
  if (!provider) provider = providerPageOf(page);
  const paypal = await payPalBehind(provider);
  if (paypal) return { url: paypal, paypal: true };
  return { url: provider, paypal: false };
}
/** PayPal: "By default, the token is only valid for three hours." */
const PAYPAL_LINK_HOURS = 3;

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
          await sfccJson('POST', `${SFCC_BASE}/CheckoutServices-AddCoupon`, {
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
    'Prepares an order WITHOUT placing it, for home delivery or pickup in store: reserves the timeslot, sets the ' +
      'saved delivery address (delivery only) and checks it matches the delivery CAP, sets the slot, then returns the ' +
      'order summary. Show that summary to the user and get their explicit approval before calling place_order. ' +
      'Take the timeslot values from get_delivery_timeslots and the store from find_stores.',
    {
      shippingMethodId: z
        .enum(['delivery', 'pickup_in_store'])
        .optional()
        .describe("'delivery' (home delivery, default) or 'pickup_in_store' (Ritiro in negozio)."),
      timeslotId: z.string().describe('timeslot_id from get_delivery_timeslots.'),
      timeslotStart: z.string().describe('start from get_delivery_timeslots, unchanged.'),
      timeslotEnd: z.string().describe('end from get_delivery_timeslots, unchanged.'),
      timeslotEco: z.boolean().describe('eco flag from get_delivery_timeslots.'),
      storeId: z.string().describe('Store ID from find_stores, under the chosen shipping method.'),
      store_cap: z.string().optional().describe("Pickup only: the store's cap, from find_stores."),
      store_city: z.string().optional().describe("Pickup only: the store's city, from find_stores, unchanged."),
      address_id: z
        .string()
        .optional()
        .describe('Delivery only: address_id from get_addresses. May be left out when the account has a single address.'),
      floor: z.string().optional().describe('Delivery only: override the saved floor.'),
      intercomName: z.string().optional().describe('Delivery only: override the name on the intercom.'),
      phone: z.string().optional().describe('Delivery only: override the contact phone (without prefix).'),
      phonePrefix: z.string().optional().describe("Delivery only: phone prefix, default '+39'."),
    },
    async (args) => {
      const pickup = args.shippingMethodId === 'pickup_in_store';
      try {
        await requireSignedIn();
        prepared = null;

        let chosen: SavedAddress | undefined;
        if (pickup) {
          if (!args.store_cap || !args.store_city) {
            throw new SfccError('Pickup needs store_cap and store_city: take them from the store in find_stores.');
          }
        } else {
          const book = await addressBook();
          const address = args.address_id
            ? book.find((a) => a.customerAddressUUID === args.address_id)
            : book.length === 1
              ? book[0]
              : undefined;
          if (!address) {
            throw new SfccError(
              book.length === 0
                ? 'No saved address. Add one on carrefour.it first.'
                : 'Pick an address: pass address_id from get_addresses.'
            );
          }
          chosen = {
            ...address,
            ...(args.floor !== undefined ? { floor: args.floor } : {}),
            ...(args.intercomName !== undefined ? { intercomName: args.intercomName } : {}),
            ...(args.phone !== undefined ? { phone: args.phone } : {}),
          };
        }

        // 1. The reservation ties the slot to the cart and names the shipment. Delivery sends the
        //    customer's CAP and city, pickup the store's; the site never fills address/streetNumber.
        const reservation = check(
          'Timeslot reservation',
          await sfccJson('POST', `${SFCC_BASE}/TimeSlotApi-ReserveTimeSlot`, {
            form: {
              shippingMethodId: pickup ? 'pickup_in_store' : 'delivery',
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
              ...(pickup
                ? { city: args.store_city!, cap: args.store_cap! }
                : {
                    city: chosen!.city ?? '',
                    cap: chosen!.postalCode ?? '',
                    address: '',
                    state: chosen!.stateCode ?? '',
                    streetNumber: '',
                  }),
            },
          })
        );
        const shipmentUUID = (reservation.reservedTimeslot as { shipmentUUID?: string } | undefined)?.shipmentUUID;
        if (!shipmentUUID) throw new SfccError('The timeslot reservation did not return a shipment.');

        // The reservation may have switched store or service: products that store cannot supply
        // stay in the cart as "non disponibili" and make the checkout bounce back to /cart.
        const unavailable = extractCart(
          await sfccHtml('GET', `${SFCC_BASE}/Minicart-Show`, { query: { cents: 'false' } })
        ).unavailable_items;
        if (unavailable?.length) {
          throw new SfccError(
            `The timeslot is reserved, but ${unavailable.length} product(s) in the cart are not available at this ` +
              `store/service: ${unavailable.map((u) => `${u.name} (${u.ean})`).join(', ')}. Tell the user, then remove ` +
              'them with remove_unavailable_products (or pick alternatives with search_products) and call prepare_checkout again.'
          );
        }

        // 2. Open the checkout like the site does; it bounces to /cart when something is off.
        //    The cart page recalculates the basket (changed prices, ended offers, a new slot): a
        //    shopper would see it and press "Procedi" again, so we do the same, once. If it still
        //    bounces, the messages shown on the cart page say why.
        const beginUrl = `${CARREFOUR_ORIGIN}/checkout/begin?cart=1&rurl=2`;
        let landed = new URL((await browserService.visit(beginUrl)).finalUrl);
        if (!landed.pathname.startsWith('/checkout')) {
          if (landed.pathname.startsWith('/cart')) {
            logger.info('Checkout bounced to the cart, retrying once after the cart page', { landed: landed.pathname + landed.search });
            landed = new URL((await browserService.visit(beginUrl)).finalUrl);
          }
        }
        if (!landed.pathname.startsWith('/checkout')) {
          const messages = await browserService.pageMessages(CARREFOUR_ORIGIN, CART_ALERTS);
          if (process.env.CARREFOUR_DEBUG_HTML) {
            const snap = await browserService.pageSnapshot(CARREFOUR_ORIGIN);
            if (snap) saveDebugPage('cart-bounce', snap.html, snap.png);
          }
          throw new SfccError(
            `carrefour.it refused to open the checkout and sent back to ${landed.pathname}${landed.search}. ` +
              (messages.length ? `The cart page says: ${messages.map((m) => `"${m}"`).join('; ')}. ` : '') +
              'Check the cart (minimum order, unavailable products) and that the delivery CAP matches the address.'
          );
        }

        // 3. Delivery address — pickup has none to submit.
        let summary: Json;
        if (!pickup) {
          const shipping = check(
            'Delivery address',
            await sfccJson('POST', `${CARREFOUR_ORIGIN}/checkout/shipping-submit`, {
              form: {
                isOnlyPickupInStore: 'false',
                csrf_token: await getCsrfToken(),
                originalShipmentUUID: shipmentUUID,
                shipmentUUID,
                ...shippingForm(chosen!, args.phonePrefix ?? '+39'),
                shippingPhonePrefix: args.phonePrefix ?? '+39',
              },
            })
          );
          summary = summarizeOrder(shipping.order as OrderJson | undefined);
        } else {
          const cart = extractCart(await sfccHtml('GET', `${SFCC_BASE}/Minicart-Show`, { query: { cents: 'false' } }));
          summary = {
            products_total: cart.total_products,
            item_count: cart.item_count,
            items: cart.items.map((i) => ({ ean: i.ean, name: i.name, quantity: i.quantity_in_cart, price: i.price })),
            note: 'Any pickup fee is shown on the payment page.',
          };
        }
        check('Address check', await sfccJson('GET', `${SFCC_BASE}/CheckoutShippingServices-ValidateShippingAddress`));

        // 4. The slot on the shipment.
        const slot = check(
          'Timeslot',
          await sfccJson('POST', `${SFCC_BASE}/Checkout-UpdateTimeslot`, {
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

        const timeslot = typeof slot.timeslotDateFormatted === 'string' ? textOf(slot.timeslotDateFormatted) : '';
        const where = pickup
          ? `ritiro in negozio ${args.storeId}, ${args.store_city}`
          : `consegna a ${describeAddress(chosen!)}`;
        prepared = { at: Date.now(), total: summary.total_to_pay ?? summary.products_total, address: where, timeslot };

        return text(
          JSON.stringify({ status: 'ready — NOT ordered yet', where, timeslot, ...summary }, null, 2) +
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
      'call it only after the user has seen the prepare_checkout summary and explicitly said to go ahead. Ask the ' +
      'user how they want to pay: PayPal (MP_PAYPAL, default) or card (MARKETPAY: Mastercard, Visa, American Express).',
    {
      confirm: z.boolean().describe('Must be true: the user explicitly approved the summary from prepare_checkout.'),
      payment_method: z
        .enum(PAYMENT_METHODS)
        .optional()
        .describe(
          "'MP_PAYPAL' (PayPal, default) or 'MARKETPAY' (credit/debit card: Mastercard, Visa or American Express, " +
            "typed by the user on Market Pay's secure page; the total is pre-authorised and the final amount " +
            'charged once the groceries are prepared).'
        ),
      order_notes: z.string().optional().describe('Notes for the order (e.g. delivery instructions).'),
    },
    async ({ confirm, payment_method, order_notes }) => {
      if (confirm !== true) {
        return text('Not placed: confirm must be true, and only after the user approved the prepare_checkout summary.', true);
      }
      if (!prepared || Date.now() - prepared.at > PREPARED_TTL_MS) {
        return text('Not placed: run prepare_checkout first (within the last 30 minutes) and show its summary to the user.', true);
      }
      const method: PaymentMethod = payment_method ?? 'MP_PAYPAL';
      try {
        await requireSignedIn();
        const data = check(
          'Order',
          await sfccJson('POST', `${CARREFOUR_ORIGIN}/checkout/payment`, {
            form: {
              paymentOptions: method,
              billingAddressEnabled: 'false',
              orderNotes: order_notes ?? '',
              csrf_token: await getCsrfToken(),
              timeslotEnabled: 'true',
            },
          })
        );
        const redirectUrl = typeof data.redirectUrl === 'string' ? data.redirectUrl : '';
        if (!redirectUrl) throw new SfccError('carrefour.it did not return a payment page.');
        const orderNumber = new URL(redirectUrl).searchParams.get('orderNumber') ?? 'unknown';
        const placed = prepared;
        prepared = null;
        if (orderNumber !== 'unknown') {
          paymentPages.set(orderNumber, redirectUrl);
          paymentMethods.set(orderNumber, method);
        }

        if (method === 'MARKETPAY') {
          // The card form is Market Pay's hosted page (carrefour.it shows it in an iframe). Its URL
          // carries the session, so it works on any device; nothing is pressed on it here.
          const card = await cardPage(redirectUrl);
          const cardUrl = card.url || providerPageOf(redirectUrl);
          const window = openInUserBrowser(cardUrl || redirectUrl);
          logger.info('Order placed, card payment page handed to the user', { orderNumber, browser: window.browser, provider: Boolean(cardUrl) });
          return paymentResult(
            [
              `Order ${orderNumber} created on carrefour.it — total ${String(placed.total)}, ${placed.address}, ${placed.timeslot}.`,
              '',
              "Card payment link (Mastercard, Visa or American Express, on Market Pay's secure page — works on any device):",
              cardUrl || redirectUrl,
              '',
              ...cardWarning(card),
              window.opened
                ? process.env.CARREFOUR_DESK_URL
                  ? `The payment page is also open on the server's screen (${process.env.CARREFOUR_DESK_URL}).`
                  : `The payment page is also open in ${window.browser}.`
                : `Could not open a browser (${window.error}); use the link.`,
              '',
              'The user types the card details there and confirms with their bank (3-D Secure). The total is ' +
                'pre-authorised (held) and the final amount is charged once the groceries are prepared.',
              `If the link stops working, call renew_payment_link with this order number (carrefour.it payment page: ${redirectUrl}).`,
              '',
              'The order is only confirmed once paid; an unpaid order is cancelled by carrefour.it. Check it with get_orders.',
            ].join('\n'),
            {
              order_number: orderNumber,
              payment_method: method,
              payment_url: cardUrl || redirectUrl,
              provider: cardUrl ? 'market_pay_card' : 'carrefour',
              carrefour_payment_page: redirectUrl,
              total: placed.total === undefined ? undefined : String(placed.total),
              link_shows_card_form: card.url ? card.standaloneFields > 0 : undefined,
              check_with: 'get_order_status',
            }
          );
        }

        // carrefour.it sends the payment page on to PayPal. The PayPal URL carries its own token, so
        // it works on any device and opens the PayPal app on a phone: hand that over when we can.
        const pay = await paymentLinkFrom(redirectUrl);
        const paypalUrl = pay.url; // PayPal, or the provider's page where the user picks PayPal

        const window = openInUserBrowser(paypalUrl || redirectUrl);
        logger.info('Order placed, payment page handed to the user', { orderNumber, browser: window.browser, provider: Boolean(paypalUrl) });
        return paymentResult(
          [
            `Order ${orderNumber} created on carrefour.it — total ${String(placed.total)}, ${placed.address}, ${placed.timeslot}.`,
            '',
            ...(paypalUrl
              ? [pay.paypal
                  ? 'Payment link (PayPal — opens the PayPal app on a phone, works on any device):'
                  : 'Payment link (payment page with PayPal — works on any device, no carrefour.it sign-in needed):', paypalUrl, '']
              : []),
            window.opened
              ? process.env.CARREFOUR_DESK_URL
                ? `The payment page is open on the server's screen (${process.env.CARREFOUR_DESK_URL}). Pay there, or open this link:`
                : `The payment page is open in ${window.browser}. Complete the payment there (PayPal sign-in and checks).`
              : `Could not open a browser (${window.error}). Open this link to pay:`,
            paypalUrl || redirectUrl,
            '',
            `PayPal links expire ${PAYPAL_LINK_HOURS} hours after they are issued. For a new one, call renew_payment_link with this order number (carrefour.it payment page: ${redirectUrl}).`,
            '',
            'The order is only confirmed once paid. Check it afterwards in Il mio account > Ordini on carrefour.it.',
          ].join('\n'),
          {
            order_number: orderNumber,
            payment_method: method,
            payment_url: paypalUrl || redirectUrl,
            provider: providerOf(paypalUrl || redirectUrl),
            carrefour_payment_page: redirectUrl,
            total: placed.total === undefined ? undefined : String(placed.total),
            expires_in_hours: PAYPAL_URL.test(paypalUrl) ? PAYPAL_LINK_HOURS : undefined,
            check_with: 'get_order_status',
          }
        );
      } catch (error) {
        logger.error('place_order failed', { error: String(error) });
        return text(`Order not placed — ${(error as Error).message}`, true);
      }
    }
  );

  server.tool(
    'renew_payment_link',
    'Gives a NEW payment link (PayPal, or the card page for orders paid by card) for an order placed with place_order that is not paid yet (the old link ' +
      'expired, the payment was cancelled, or the page no longer opens). It reopens the order\'s carrefour.it ' +
      'payment page in the signed-in browser and follows it to PayPal. It does not create a new order. If ' +
      'carrefour.it no longer sends the order to PayPal, the order was cancelled (unpaid) or already paid: check ' +
      'get_orders, and place a new order if needed.',
    {
      order_number: z.string().describe('Order number from place_order.'),
      payment_page_url: z
        .string()
        .optional()
        .describe('The carrefour.it payment page printed by place_order; needed after a server restart.'),
      payment_method: z
        .enum(PAYMENT_METHODS)
        .optional()
        .describe("How the order is paid, as chosen in place_order; needed after a server restart for card ('MARKETPAY') orders."),
    },
    async ({ order_number, payment_page_url, payment_method }) => {
      try {
        await requireSignedIn();
        let page = paymentPages.get(order_number) ?? '';
        if (payment_page_url) {
          let given: URL;
          try {
            given = new URL(payment_page_url);
          } catch {
            throw new SfccError('payment_page_url is not a URL.');
          }
          if (given.protocol !== 'https:' || !/(^|\.)carrefour\.it$/.test(given.hostname) || given.searchParams.get('orderNumber') !== order_number) {
            throw new SfccError('payment_page_url must be the carrefour.it payment page of this order (as printed by place_order).');
          }
          page = given.toString();
        }
        if (!page) throw new SfccError(`No payment page known for order ${order_number}: pass payment_page_url as printed by place_order.`);
        const method: PaymentMethod = payment_method ?? paymentMethods.get(order_number) ?? 'MP_PAYPAL';
        let paypalUrl = '';
        let renewedCard = { url: '', fields: 0, standaloneFields: 0 };
        try {
          if (method === 'MARKETPAY') {
            // A card order stays on Market Pay's card page, as carrefour.it shows it: nothing is pressed there.
            renewedCard = await cardPage(page);
            paypalUrl = renewedCard.url || (await browserService.followRedirect(page, OFF_CARREFOUR, PAYPAL_REDIRECT_TIMEOUT_MS));
          } else {
            paypalUrl = await browserService.followRedirect(page, OFF_CARREFOUR, PAYPAL_REDIRECT_TIMEOUT_MS);
            paypalUrl = (await payPalBehind(paypalUrl)) || paypalUrl;
          }
        } catch (error) {
          logger.info('renew_payment_link: no payment page', { order: order_number, error: String(error) });
          throw new SfccError(
            `carrefour.it no longer sends order ${order_number} to ${method === 'MARKETPAY' ? 'the card payment page' : 'PayPal'}: it was probably cancelled for missing payment ` +
              '(or it is already paid — check get_orders). Place a new order to pay.'
          );
        }
        paymentPages.set(order_number, page);
        paymentMethods.set(order_number, method);
        if (method === 'MARKETPAY') {
          return paymentResult(
            [
              `New card payment link for order ${order_number} (Mastercard, Visa or American Express on Market Pay's secure page, works on any device):`,
              paypalUrl,
              '',
              ...cardWarning(renewedCard),
              'The order is only confirmed once paid.',
            ].join('\n'),
            {
              order_number,
              payment_method: method,
              payment_url: paypalUrl,
              provider: 'market_pay_card',
              carrefour_payment_page: page,
              check_with: 'get_order_status',
            }
          );
        }
        return paymentResult(
          [
            `New payment link for order ${order_number} (${PAYPAL_URL.test(paypalUrl) ? 'PayPal — opens the PayPal app on a phone' : 'payment page with PayPal'}, works on any device):`,
            paypalUrl,
            '',
            `It expires ${PAYPAL_LINK_HOURS} hours from now. The order is only confirmed once paid.`,
          ].join('\n'),
          {
            order_number,
            payment_method: method,
            payment_url: paypalUrl,
            provider: providerOf(paypalUrl),
            carrefour_payment_page: page,
            expires_in_hours: PAYPAL_URL.test(paypalUrl) ? PAYPAL_LINK_HOURS : undefined,
            check_with: 'get_order_status',
          }
        );
      } catch (error) {
        logger.error('renew_payment_link failed', { error: String(error) });
        return text(`No new payment link — ${(error as Error).message}`, true);
      }
    }
  );
}
