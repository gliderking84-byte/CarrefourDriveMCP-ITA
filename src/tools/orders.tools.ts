import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CARREFOUR_ORIGIN, SFCC_BASE } from '../services/session.service.js';
import { SfccError, check, requireSignedIn, sfccHtml, sfccJson, type Json } from '../services/sfcc.service.js';
import { chunks, decodeEntities, parseProduct, textOf, type Product } from '../spec/extract.js';

/**
 * Past orders: history and status, details, receipt, reorder.
 *
 * From captured traffic: the "I miei ordini" page reads Order-HistoryOrders
 * (JSON, one entry per order with its shipments, status, receipt and reorder
 * links) and the "Riordina" button is a GET of the shipment's reorderUrl
 * (Order-Reorder), which adds its products to the cart. The receipt is a PDF on
 * Carrefour's Salesforce file server (receiptUrl), opened and printed from
 * there. The detail page /account/order?orderID=… is server-rendered HTML and
 * was not captured: its product lines are read with the site's usual tile
 * markup (data-product-json / data-pid).
 *
 * Customer names, phone, e-mail, loyalty card and street address in the
 * history are left out of every answer: the tools only need the order itself.
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

export interface OrderShipment {
  shipment_no?: string;
  shipment_id?: string;
  method?: string;
  store_id?: string;
  city?: string;
  product_count?: number;
  status?: string;
  status_code?: string;
  timeslot?: string;
  receipt_url?: string;
  invoice_url?: string;
  tracking_url?: string;
  can_reorder: boolean;
  reorder_url?: string;
  can_return: boolean;
  last_day_for_return?: string;
}

export interface OrderSummary {
  order_number: string;
  total?: string;
  shipping?: string;
  payment?: string[];
  shipments: OrderShipment[];
  detail_url?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const absolute = (url: string | undefined) => (url ? new URL(decodeEntities(url), CARREFOUR_ORIGIN).toString() : undefined);

function parseShipment(raw: unknown): OrderShipment {
  const s = obj(raw);
  const status = obj(s.status);
  const date = str(s.timeslotDate);
  const from = str(s.timeslotStartTime);
  const to = str(s.timeslotEndTime);
  const count = Number(s.productCount);
  const shipment: OrderShipment = {
    shipment_no: str(s.cShipmentNo) ?? str(s.C4_ShipmentNo),
    shipment_id: str(s.id),
    method: str(s.shippingMetodDescription) ?? (str(s.courierLabel) ? textOf(String(s.courierLabel)) : undefined),
    store_id: str(s.storeId),
    city: str(obj(s.shippingAddress).city),
    product_count: Number.isFinite(count) && String(s.productCount ?? '') !== '' ? count : undefined,
    status: str(status.description),
    status_code: str(status.code),
    timeslot: date ? [date, from && to ? `${from}-${to}` : from].filter(Boolean).join(' ') : undefined,
    receipt_url: absolute(str(s.receiptUrl)),
    invoice_url: absolute(str(s.invoiceUrl)),
    tracking_url: absolute(str(s.trackingUrl)),
    can_reorder: s.canBeReordered === true && !!str(s.reorderUrl),
    reorder_url: absolute(str(s.reorderUrl)),
    can_return: s.canBeReturned === true,
    last_day_for_return: str(s.lastDayForReturn),
  };
  return Object.fromEntries(Object.entries(shipment).filter(([, v]) => v !== undefined)) as unknown as OrderShipment;
}

/** The orders in an Order-HistoryOrders answer, without the customer's personal data. */
export function parseOrderHistory(data: unknown): { orders: OrderSummary[]; has_more: boolean } {
  const history = obj(obj(data).orderHistory);
  const orders = (Array.isArray(history.orders) ? history.orders : []).flatMap((raw): OrderSummary[] => {
    const o = obj(raw);
    const number = str(o.orderNumber);
    if (!number) return [];
    const payment = (Array.isArray(o.paymentMethodDescriptions) ? o.paymentMethodDescriptions : [])
      .map((p) => str(obj(p).description))
      .filter((p): p is string => !!p);
    const order: OrderSummary = {
      order_number: number,
      total: str(obj(o.orderTotal).formatted),
      shipping: str(obj(o.shippingTotal).formatted),
      payment: payment.length ? payment : undefined,
      shipments: (Array.isArray(o.shipments) ? o.shipments : []).map(parseShipment),
      detail_url: absolute(str(o.orderDetailUrl)),
    };
    return [Object.fromEntries(Object.entries(order).filter(([, v]) => v !== undefined)) as unknown as OrderSummary];
  });
  return { orders, has_more: history.hasNextOrders === true };
}

export interface OrderLine extends Product {
  quantity?: number;
}

/**
 * The product lines of an order detail page. Lines are taken from the site's
 * product markup (data-product-json, else data-pid); a quantity is read from
 * data-option-quantity / data-quantity, or a "Quantità: n" / "n pz" label.
 */
export function parseOrderDetailProducts(html: string): OrderLine[] {
  // One chunk per element carrying product data; consecutive chunks naming the
  // same EAN (a line and, say, its image or button) are one product line.
  const groups: Array<{ ean: string; chunk: string }> = [];
  for (const chunk of chunks(html, /<[a-z][a-z0-9]*\b[^>]*?\s(?:data-product-json|data-pid)=/i)) {
    const ean = parseProduct(chunk)?.ean;
    const last = groups.at(-1);
    if (last && (!ean || ean === last.ean)) last.chunk += chunk;
    else if (ean) groups.push({ ean, chunk });
  }

  const lines = new Map<string, OrderLine>();
  for (const { ean, chunk } of groups) {
    if (lines.has(ean)) continue;
    const product = parseProduct(chunk)!;
    const line: OrderLine = { ...product };
    delete line.quantity_in_cart;
    const fromAttr = Number(chunk.match(/data-(?:option-)?quantity="(\d+)"/)?.[1]);
    const label = textOf(chunk).match(/(?:Quantit[àa]|Q\.t[àa]|Qt[àa])\s*:?\s*(\d+)|\b(\d+)\s*(?:pz|pezzi)\b/i);
    const fromText = Number(label?.[1] ?? label?.[2]);
    const quantity = [fromAttr, fromText].find((q) => Number.isFinite(q) && q > 0);
    if (quantity) line.quantity = quantity;
    if (!line.name) line.name = textOf(chunk.match(/<a\b[^>]*href="[^"]*\/p\/[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
    lines.set(ean, line);
  }
  return [...lines.values()];
}

async function history(size: number): Promise<{ orders: OrderSummary[]; has_more: boolean }> {
  const data = check(
    'Order history',
    await sfccJson('GET', `${SFCC_BASE}/Order-HistoryOrders`, { query: { sz: String(size), fromapp: 'false' } })
  );
  return parseOrderHistory(data);
}

/** One order from the history; the most recent one when no number is given. */
async function findOrder(orderNumber?: string): Promise<OrderSummary> {
  const wanted = orderNumber?.trim();
  const { orders } = await history(wanted ? 50 : 1);
  const order = wanted ? orders.find((o) => o.order_number === wanted) : orders[0];
  if (!order) {
    throw new SfccError(
      wanted
        ? `Order ${wanted} is not among the last ${orders.length} orders of this account. Check the number with get_orders.`
        : 'This account has no orders yet.'
    );
  }
  return order;
}

const orderNumberParam = z
  .string()
  .optional()
  .describe('order_number from get_orders (e.g. "01234567"). Omit for the most recent order.');

export function registerOrderTools(server: McpServer): void {
  server.tool(
    'get_orders',
    "Lists the signed-in customer's recent orders (I miei ordini), newest first: order number, total, payment, " +
      'and per shipment the delivery or pickup method, timeslot, number of products, status (e.g. "Pronto per la ' +
      'consegna"), and whether a receipt, invoice, tracking or reorder is available. Use it to check an order\'s status.',
    { limit: z.number().int().min(1).max(50).optional().describe('How many orders to return (default 10).') },
    ({ limit }) =>
      run(async () => {
        await requireSignedIn();
        const { orders, has_more } = await history(limit ?? 10);
        if (orders.length === 0) return 'No order found for this account.';
        return JSON.stringify({ count: orders.length, has_more, orders }, null, 2);
      })
  );

  server.tool(
    'get_order_status',
    'Checks the status of one order (verifica ordine): status of each shipment, delivery or pickup timeslot, ' +
      'total, and whether the receipt is ready.',
    { order_number: orderNumberParam },
    ({ order_number }) =>
      run(async () => {
        await requireSignedIn();
        const order = await findOrder(order_number);
        return JSON.stringify(
          {
            order_number: order.order_number,
            total: order.total,
            shipments: order.shipments.map((s) => ({
              shipment_no: s.shipment_no,
              method: s.method,
              timeslot: s.timeslot,
              status: s.status,
              status_code: s.status_code,
              receipt_ready: !!s.receipt_url,
              tracking_url: s.tracking_url,
            })),
          },
          null,
          2
        );
      })
  );

  server.tool(
    'get_order_details',
    'Shows the details of one order (dettaglio ordine): status, timeslot, totals, payment, and the products ' +
      'ordered with EAN, name, price and quantity where the page shows it.',
    { order_number: orderNumberParam },
    ({ order_number }) =>
      run(async () => {
        await requireSignedIn();
        const order = await findOrder(order_number);
        const html = await sfccHtml('GET', `${CARREFOUR_ORIGIN}/account/order`, {
          query: { orderID: order.order_number, fromapp: 'false' },
          page: true,
        });
        const products = parseOrderDetailProducts(html);
        const details: Json = { ...order, product_count: products.length, products };
        if (products.length === 0) {
          details.note =
            'The products could not be read from the order page. The order summary above is complete; ' +
            'to list the products, open detail_url, or reorder them with reorder_order.';
        }
        return JSON.stringify(details, null, 2);
      })
  );

  server.tool(
    'get_order_receipt',
    'Gives the link to the receipt (scontrino / ricevuta, PDF) of an order, and the invoice when there is one, ' +
      'to open and print. The receipt appears once the order has been prepared.',
    { order_number: orderNumberParam },
    ({ order_number }) =>
      run(async () => {
        await requireSignedIn();
        const order = await findOrder(order_number);
        const docs = order.shipments
          .filter((s) => s.receipt_url || s.invoice_url)
          .map((s) => ({ shipment_no: s.shipment_no, receipt_url: s.receipt_url, invoice_url: s.invoice_url }));
        if (docs.length === 0) {
          const status = order.shipments.map((s) => s.status).filter(Boolean).join(', ');
          throw new SfccError(
            `Order ${order.order_number} has no receipt yet${status ? ` (status: ${status})` : ''}. ` +
              'It is published once the order has been prepared; try again later.'
          );
        }
        return JSON.stringify(
          {
            order_number: order.order_number,
            documents: docs,
            how_to_print: 'Open the link (a PDF) in a browser and print it, or save it.',
          },
          null,
          2
        );
      })
  );

  server.tool(
    'reorder_order',
    'Adds the products of a past order to the cart again (Riordina), at today\'s prices and availability. ' +
      'A delivery method must be selected first (reserve_delivery_timeslot). Products already in the cart stay.',
    {
      order_number: orderNumberParam,
      shipment_no: z.string().optional().describe('Only this shipment of the order (shipment_no from get_orders).'),
    },
    ({ order_number, shipment_no }) =>
      run(async () => {
        await requireSignedIn();
        const order = await findOrder(order_number);
        const shipments = order.shipments.filter((s) => !shipment_no || s.shipment_no === shipment_no);
        if (shipments.length === 0) throw new SfccError(`Order ${order.order_number} has no shipment ${shipment_no}.`);
        const reorderable = shipments.filter((s) => s.can_reorder && s.reorder_url);
        if (reorderable.length === 0) throw new SfccError(`Order ${order.order_number} cannot be reordered from carrefour.it.`);

        const results = [];
        for (const s of reorderable) {
          const url = new URL(s.reorder_url!);
          if (url.origin !== CARREFOUR_ORIGIN || !url.pathname.endsWith('/Order-Reorder')) {
            throw new SfccError('Unexpected reorder link in the order history; nothing was added.');
          }
          const data = await sfccJson('GET', url.toString());
          if (data.error === true && !data.errorMessage) {
            throw new SfccError(`Reorder: ${textOf(String(data.message ?? 'carrefour.it refused it'))}`);
          }
          check('Reorder', data);
          results.push({ shipment_no: s.shipment_no, message: data.message, cart_items: data.quantity, cart_total: data.totalPrice });
        }
        return JSON.stringify({ order_number: order.order_number, reordered: results }, null, 2);
      })
  );
}
