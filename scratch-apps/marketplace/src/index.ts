// acme.market: a vendor per product, a vendor dashboard, split fulfilment
// notices and payout reports. Public SDK only; hacks are marked.
//
// Model: `vendors` records; a product custom field `vendor` (object reference)
// names the product's vendor; `order.created` splits the order into one
// `vendor_orders` record per vendor (lines, subtotal, commission). A vendor
// is a customer account linked to a vendor record (HACK: there is no vendor
// or partner principal, and staff roles cannot be scoped to "own products",
// so the vendor dashboard is a storefront proxy page; DX-REPORT MKT-1).

import {
  adminContext,
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  wantsPage,
  type PluginContext,
  type PluginManifestInput,
  type PluginRouteRequest,
} from "@scalius/plugin-sdk";
// Proxy pages take an HTML string. The storefront SDK's escaper works in a
// route too, but nothing says so; the first draft of this page interpolated
// vendor names unescaped (DX-REPORT SEC-3).
import { escapeHtml } from "@scalius/plugin-sdk/storefront";

export const manifest = {
  id: "acme.market",
  name: "Marketplace",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Sell products from many vendors: each vendor sees and ships their own lines, and you get a payout report.",
  author: { name: "Acme" },
  categories: ["operations", "finances"],
  support: { email: "support@acme.example" },
  scopes: ["read_products", "read_orders", "write_fulfillments", "read_customers"],
  events: ["order.created", "order.cancelled", "order.refunded"],
  objects: {
    vendors: {
      name: "Vendors",
      display: "name",
      admin: "edit",
      storefront: true,
      handle: true,
      fields: [
        { key: "name", name: "Name", type: "single_line_text", required: true },
        { key: "email", name: "Notification email", type: "single_line_text", required: true },
        { key: "commission_bp", name: "Commission (basis points)", type: "integer", validations: { min: 0, max: 10000 } },
        { key: "account_customer_id", name: "Vendor's account", type: "customer_reference" },
      ],
      indexes: ["account_customer_id"],
    },
    vendor_orders: {
      name: "Vendor orders",
      admin: "read",
      fields: [
        { key: "vendor_id", name: "Vendor", type: "object_reference", to: "acme.market.vendors", required: true },
        { key: "order_id", name: "Order", type: "order_reference", required: true },
        { key: "period", name: "Payout period (YYYY-MM)", type: "single_line_text", required: true },
        { key: "status", name: "Status", type: "single_line_text", validations: { choices: ["open", "shipped", "cancelled"] } },
        // Integers in minor units: a `money` field reads back in decimal major units (DX-REPORT CORE-4).
        { key: "subtotal_minor", name: "Subtotal (minor units)", type: "integer" },
        { key: "commission_minor", name: "Commission (minor units)", type: "integer" },
        { key: "lines", name: "Lines", type: "json" },
      ],
      indexes: [["vendor_id", "period"], "order_id"],
    },
  },
  customFields: [
    { ownerType: "product", key: "vendor", name: "Vendor", type: "object_reference", to: "acme.market.vendors", storefrontVisible: true },
    // HACK: product blocks cannot read objects, so the block cannot turn the
    // vendor reference into a name; the name is copied onto the product.
    { ownerType: "product", key: "vendor_name", name: "Vendor name", type: "single_line_text", storefrontVisible: true },
  ],
  timeline: [{ kind: "vendor-split", title: "Split between vendors" }],
  routes: {
    admin: [{ name: "payouts", methods: ["GET"] }],
    public: [{ name: "vendor", methods: ["GET", "POST"], description: "The vendor's own dashboard." }],
    webhooks: [],
  },
  admin: { pages: [{ id: "payouts", title: "Vendor payouts", placement: "analytics", route: "payouts" }] },
  storefront: {
    proxy: true,
    productBlocks: [{ type: "sold-by", name: "Sold by", placement: "buy-box", settings: [] }],
  },
} satisfies PluginManifestInput;

const vendors = (ctx: PluginContext) => ctx.objects.vendors!;
const vendorOrders = (ctx: PluginContext) => ctx.objects.vendor_orders!;

interface Item { id: string; productId: string; quantity: number; productName: string | null; lineSubtotalMinor: number | null; discountAmountMinor: number | null }

/** The vendor of each product, read once per product and cached for an hour in private kv. */
async function vendorOf(ctx: PluginContext, productId: string): Promise<string | null> {
  const cached = await ctx.kv.get<{ vendor: string | null }>(`pv:${productId}`);
  if (cached) return cached.vendor;
  // One API call per distinct product: function inputs and order items carry
  // no custom fields (DX-REPORT CORE-1).
  const values = await ctx.customFields.get("product", productId);
  const vendor = typeof values.vendor === "string" ? values.vendor : null;
  await ctx.kv.set(`pv:${productId}`, { vendor }, { ttlSeconds: 3600 });
  return vendor;
}

/** A UUID derived from a stable string, for operations whose retry key must be a UUID. */
export async function uuidFrom(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function commission(subtotalMinor: number, basisPoints: number): number {
  return Math.round((subtotalMinor * basisPoints) / 10_000);
}

async function split(orderId: string, ctx: PluginContext): Promise<void> {
  const order = await ctx.api.call<{ createdAt: string }>("dashboard.orders.get", { path: { id: orderId } });
  const items = await ctx.api.call<Item[]>("dashboard.orders.items", { path: { id: orderId } });
  if (!order.ok || !order.data || !items.ok || !items.data) throw new Error("The order could not be read; retry.");
  const period = order.data.createdAt.slice(0, 7);
  const byVendor = new Map<string, Item[]>();
  for (const item of items.data) {
    const vendor = await vendorOf(ctx, item.productId);
    if (vendor) byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), item]);
  }
  const writes = [];
  for (const [vendorId, lines] of byVendor) {
    const vendor = await vendors(ctx).get(vendorId);
    if (!vendor) continue;
    const subtotal = lines.reduce((sum, line) => sum + (line.lineSubtotalMinor ?? 0) - (line.discountAmountMinor ?? 0), 0);
    writes.push({
      op: "put" as const, object: "vendor_orders", id: `${orderId}:${vendorId}`, expectedRevision: null,
      record: {
        vendor_id: vendorId, order_id: orderId, period, status: "open", subtotal_minor: subtotal,
        commission_minor: commission(subtotal, Number(vendor.commission_bp ?? 0)),
        lines: lines.map((line) => ({ itemId: line.id, title: line.productName ?? "", quantity: line.quantity })),
      },
    });
  }
  if (writes.length === 0) return;
  try {
    await ctx.objects.batch(writes.slice(0, 25));
  } catch (error) {
    // A redelivered event finds its records: nothing to do.
    if ((error as { code?: string }).code === "object.conflict") return;
    throw error;
  }
  for (const write of writes) {
    const vendor = await vendors(ctx).get(write.record.vendor_id);
    // The vendor's address comes from the app's own record, so `to` is an
    // arbitrary address: the store's sender reaches anyone (DX-REPORT SEC-2).
    await ctx.messaging.email({
      to: String(vendor?.email ?? ""),
      subject: `New order to ship: ${write.record.lines.length} line(s)`,
      html: `<p>You have a new order. Open your vendor dashboard to ship it.</p>`,
    });
  }
}

async function vendorDashboard(request: PluginRouteRequest, ctx: PluginContext) {
  const customerId = request.customer?.id;
  if (!customerId) return { body: { redirect: "/account/login?next=/apps/acme.market/vendor" } };
  const mine = await vendors(ctx).query({ where: { account_customer_id: customerId }, limit: 1 });
  const vendor = mine.records[0];
  if (!vendor) return { status: 403, body: wantsPage(request) ? { page: { title: "Vendors", html: "<p>This account is not a vendor.</p>" } } : { error: "not_a_vendor" } };
  if (request.method === "POST") {
    // The vendor ships their part: a partial fulfilment of the order.
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = `${String(body.order_id)}:${vendor.id}`;
    const current = await vendorOrders(ctx).getVersion(id);
    if (!current || current.data.vendor_id !== vendor.id || current.data.status !== "open") return { body: { redirect: "/apps/acme.market/vendor?error=1" } };
    const lines = (current.data.lines as Array<{ itemId: string; quantity: number }>).map((line) => ({ itemId: line.itemId, quantity: line.quantity }));
    const result = await ctx.api.call("dashboard.orders.fulfillment_create", {
      path: { id: String(current.data.order_id) },
      idempotencyKey: `ship-${id}`.slice(0, 200),
      // Two idempotency mechanisms on one call: the Idempotency-Key header and a
      // body requestKey that must be a UUID (DX-REPORT API-1). Both are derived.
      body: { requestKey: await uuidFrom(`ship-${id}`), kind: "ship", lines, tracking: { courierName: String(body.courier ?? "").slice(0, 120), trackingId: String(body.tracking ?? "").slice(0, 180) } },
    });
    if (!result.ok) return { body: { redirect: "/apps/acme.market/vendor?error=1" } };
    await vendorOrders(ctx).update(id, { status: "shipped" }, { expectedRevision: current.revision });
    return { body: { redirect: "/apps/acme.market/vendor?shipped=1" } };
  }
  const period = new Date().toISOString().slice(0, 7);
  const open = await vendorOrders(ctx).query({ where: { vendor_id: vendor.id, period }, limit: 50 });
  // HACK: proxy pages are HTML strings with no SDK components, no islands and no cache.
  const rows = open.records.map((record) => `<tr><td>${escapeHtml(String(record.data.order_id))}</td><td>${escapeHtml(String(record.data.status))}</td><td>${Number(record.data.subtotal_minor) / 100}</td><td>${record.data.status === "open"
    ? `<form method="post" action="/apps/acme.market/vendor"><input type="hidden" name="order_id" value="${escapeHtml(String(record.data.order_id))}"><input name="courier" placeholder="Courier"><input name="tracking" placeholder="Tracking"><button>Mark shipped</button></form>`
    : ""}</td></tr>`).join("");
  return { body: { page: { title: `${String(vendor.data.name)}: orders`, html: `<h1>${escapeHtml(String(vendor.data.name))}</h1><table><thead><tr><th>Order</th><th>Status</th><th>Subtotal</th><th></th></tr></thead><tbody>${rows}</tbody></table>` } } };
}

async function payouts(request: PluginRouteRequest, ctx: PluginContext) {
  const admin = adminContext(request);
  const period = typeof request.query.period === "string" ? request.query.period : new Date().toISOString().slice(0, 7);
  const list = await vendors(ctx).query({ limit: 50, cursor: admin.cursor });
  const rows = [];
  for (const vendor of list.records) {
    // A report is a full scan per vendor and period: Objects have no
    // aggregates (sum/group by), so the app pages and adds (DX-REPORT MKT-3).
    let cursor: string | null = null;
    let gross = 0;
    let fee = 0;
    do {
      const page = await vendorOrders(ctx).query({ where: { vendor_id: vendor.id, period }, limit: 100, cursor });
      for (const record of page.records) {
        if (record.data.status === "cancelled") continue;
        gross += Number(record.data.subtotal_minor);
        fee += Number(record.data.commission_minor);
      }
      cursor = page.nextCursor;
    } while (cursor);
    rows.push({ id: vendor.id, cells: { vendor: String(vendor.data.name), gross: { money: gross }, fee: { money: fee }, payout: { money: gross - fee } } });
  }
  return {
    body: ui.page([
      ui.table({
        caption: `Period ${period}`,
        columns: [{ key: "vendor", label: "Vendor" }, { key: "gross", label: "Sales", align: "end" }, { key: "fee", label: "Commission", align: "end" }, { key: "payout", label: "Payout", align: "end" }],
        rows,
        pagination: { next: list.nextCursor },
        empty: { title: "No vendors yet" },
      }),
    ], { title: "Vendor payouts" }),
  };
}

async function cancelSplit(orderId: string, ctx: PluginContext): Promise<void> {
  const page = await vendorOrders(ctx).query({ where: { order_id: orderId }, limit: 25 });
  for (const record of page.records) {
    if (record.data.status !== "cancelled") await vendorOrders(ctx).update(record.id, { status: "cancelled" }, { expectedRevision: record.revision });
  }
}

export default definePlugin({
  manifest,
  events: {
    "order.created": (event, ctx) => split(event.resource.id, ctx),
    "order.cancelled": (event, ctx) => cancelSplit(event.resource.id, ctx),
    // HACK: a refund names no lines in its facts, so a partial refund cannot
    // be charged to the right vendor without re-reading the whole order.
    "order.refunded": (event, ctx) => { ctx.log.info("Refund: adjust the vendor by hand", { orderId: event.resource.id }); },
  },
  routes: { admin: { payouts }, public: { vendor: vendorDashboard } },
});
