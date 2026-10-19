// acme.subscribe: "subscribe & save" on the product page, recurring orders
// and a buyer portal to skip or cancel. Public SDK only; hacks are marked.
//
// How a buyer subscribes: the merchant adds a buyer input (product
// customization) with key `subscribe` and the values `""`, `30`, `60` to each
// subscribable product. HACK: an app cannot attach a selling plan to a cart
// line, cannot declare a buyer input on products, and the product page
// projection does not show the product's buyer inputs to a product block
// (DX-REPORT SUB-1). The product block below only explains the offer.

import {
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  type PluginContext,
  type PluginManifestInput,
  type PluginRouteRequest,
} from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.subscribe",
  name: "Subscribe & save",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Buyers subscribe to a product at a discount; the app places each renewal and buyers skip or cancel from their account.",
  author: { name: "Acme" },
  categories: ["orders", "marketing"],
  support: { email: "support@acme.example" },
  // Renewals copy the buyer's name, phone and address into a new order:
  // dashboard.orders.create takes contact fields, not a customer id.
  scopes: ["read_orders", "write_orders", "read_customers", "read_customer_names", "read_customer_phones", "read_customer_emails", "read_customer_addresses"],
  events: ["order.created"],
  objects: {
    subscriptions: {
      name: "Subscriptions",
      admin: "read",
      fields: [
        { key: "customer_id", name: "Buyer", type: "customer_reference", required: true },
        { key: "product_id", name: "Product", type: "product_reference", required: true },
        { key: "variant_id", name: "Variant", type: "variant_reference", required: true },
        { key: "title", name: "Title", type: "single_line_text" },
        { key: "quantity", name: "Quantity", type: "integer", required: true },
        { key: "interval_days", name: "Every (days)", type: "integer", required: true },
        { key: "next_at", name: "Next renewal", type: "date", required: true },
        { key: "status", name: "Status", type: "single_line_text", validations: { choices: ["active", "cancelled"] } },
        { key: "cycle", name: "Renewals placed", type: "integer" },
        { key: "source_order", name: "First order", type: "order_reference" },
      ],
      // Equality on the leading fields only, no ranges: "due" is read in
      // next_at order and the page stops at the first future date.
      indexes: [["status", "next_at"], "customer_id"],
    },
    // HACK: Buyer UI gets at most one record (id = customer id) of one object
    // type, so every subscription is mirrored into one record per buyer for
    // the account block (DX-REPORT CORE-2).
    portals: {
      name: "Buyer portals",
      admin: "none",
      fields: [{ key: "items", name: "Subscriptions", type: "json" }],
    },
  },
  customFields: [
    { ownerType: "product", key: "offered", name: "Offers subscriptions", type: "boolean", storefrontVisible: true },
  ],
  functions: [
    { point: "checkout.discounts", priority: 50 },
    { point: "buyer.ui", targets: ["customer-account.order-index.block.render"], snapshot: { object: "portals" } },
  ],
  settings: [
    { key: "percent_off", label: "Subscriber discount (%)", type: "number", min: 1, max: 50, default: 10 },
  ],
  routes: {
    admin: [{ name: "overview", methods: ["GET"] }],
    public: [{ name: "manage", methods: ["POST"], description: "Skip or cancel, from the buyer's account." }],
    webhooks: [],
  },
  cron: [{ name: "renew", schedule: "0 * * * *" }],
  admin: { pages: [{ id: "overview", title: "Subscriptions", placement: "orders", route: "overview" }] },
  storefront: {
    proxy: true,
    productBlocks: [{
      type: "subscribe-note",
      name: "Subscribe & save",
      placement: "buy-box",
      settings: [{ key: "text", label: "Text", type: "text", default: "Subscribe in the options above and save on every delivery.", maxLength: 200 }],
    }],
  },
} satisfies PluginManifestInput;

interface Subscription extends Record<string, unknown> {
  customer_id: string;
  product_id: string;
  variant_id: string;
  title: string;
  quantity: number;
  interval_days: number;
  next_at: string;
  status: "active" | "cancelled";
  cycle: number;
  source_order: string;
}

const subs = (ctx: PluginContext) => ctx.objects.subscriptions!;
const portals = (ctx: PluginContext) => ctx.objects.portals!;

export function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** A stable UUID for a renewal, because `requestKey` must be a UUID (orders.create). */
export async function renewalKey(subscriptionId: string, cycle: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${subscriptionId}:${cycle}`)));
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function syncPortal(ctx: PluginContext, customerId: string): Promise<void> {
  const page = await subs(ctx).query({ where: { customer_id: customerId }, limit: 100 });
  const items = page.records
    .filter((record) => record.data.status === "active")
    .map((record) => ({ id: record.id, title: String(record.data.title), next_at: String(record.data.next_at), every: Number(record.data.interval_days) }));
  await portals(ctx).put(customerId, { items });
}

interface OrderLine { id: string; productId: string; variantId: string | null; quantity: number; productName: string | null; properties: Array<{ key: string; value: string }> }

async function captureSubscriptions(orderId: string, ctx: PluginContext): Promise<void> {
  const order = await ctx.api.call<{ customerRecord: { id: string; kind: string } | null; createdAt: string; channelSource: string | null }>("dashboard.orders.get", { path: { id: orderId } });
  if (!order.ok || !order.data) { if (order.status >= 500) throw new Error("retry"); return; }
  // Renewals the app placed carry its channel source; they must not subscribe again.
  if (order.data.channelSource === "acme-subscribe") return;
  const customer = order.data.customerRecord;
  if (!customer || customer.kind !== "account") return;
  const items = await ctx.api.call<OrderLine[]>("dashboard.orders.items", { path: { id: orderId } });
  if (!items.ok || !items.data) throw new Error("retry");
  const today = order.data.createdAt.slice(0, 10);
  let created = 0;
  for (const line of items.data) {
    const every = Number(line.properties.find((property) => property.key === "subscribe")?.value ?? 0);
    if (!line.variantId || !(every === 30 || every === 60)) continue;
    const id = `sub_${orderId}_${line.id}`;
    if (await subs(ctx).get(id)) continue; // redelivery
    const record: Subscription = {
      customer_id: customer.id, product_id: line.productId, variant_id: line.variantId, title: line.productName ?? "Subscription",
      quantity: line.quantity, interval_days: every, next_at: addDays(today, every), status: "active", cycle: 0, source_order: orderId,
    };
    await subs(ctx).put(id, record, { expectedRevision: null });
    created += 1;
  }
  if (created > 0) await syncPortal(ctx, customer.id);
}

interface CustomerView { id: string; name: string | null; email: string | null; phone: string | null; addresses: Array<{ isDefault: boolean; countryCode: string; line1: string | null; locality: string | null; adminArea: string | null; postalCode: string | null }> }

/** Places one renewal. At-most-once per cycle through the derived request key. */
async function renew(ctx: PluginContext, id: string, sub: Subscription, revision: number): Promise<"placed" | "skipped"> {
  const customer = await ctx.api.call<CustomerView>("dashboard.customers.get", { path: { id: sub.customer_id } });
  if (!customer.ok || !customer.data?.phone || !customer.data.name) return "skipped";
  const address = customer.data.addresses.find((entry) => entry.isDefault) ?? customer.data.addresses[0];
  const requestKey = await renewalKey(id, sub.cycle + 1);
  // HACK: a staff order has no customer id, no unit price, no payment method
  // and no off-session charge: the renewal is a cash-on-delivery order that
  // the buyer is not even linked to except by phone (DX-REPORT SUB-2).
  const order = await ctx.api.call("dashboard.orders.create", {
    idempotencyKey: requestKey,
    body: {
      requestKey,
      customerName: customer.data.name,
      customerPhone: customer.data.phone,
      customerEmail: customer.data.email,
      shippingCountryCode: address?.countryCode ?? null,
      shippingAddress: address?.line1 ?? null,
      shippingLocality: address?.locality ?? null,
      shippingAdminArea: address?.adminArea ?? null,
      shippingPostalCode: address?.postalCode ?? null,
      notes: `Subscription renewal ${sub.cycle + 1}`,
      // HACK: the subscriber price is an order-level decimal discount, the
      // only price lever the operation has.
      discountAmount: 0,
      shippingCharge: 0,
      channelSource: "acme-subscribe",
      items: [{ productId: sub.product_id, variantId: sub.variant_id, quantity: sub.quantity }],
    },
  });
  if (!order.ok) {
    ctx.log.warn("Renewal refused", { subscription: id, code: order.error?.code });
    return "skipped";
  }
  await subs(ctx).put(id, { ...sub, cycle: sub.cycle + 1, next_at: addDays(sub.next_at, sub.interval_days) }, { expectedRevision: revision });
  return "placed";
}

async function manage(request: PluginRouteRequest, ctx: PluginContext) {
  const customerId = request.customer?.id;
  if (!customerId) return { status: 401, body: { toast: { message: "Sign in again.", tone: "critical" } } };
  const body = (request.body ?? {}) as { id?: unknown; action?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  const current = await subs(ctx).getVersion(id);
  if (!current || current.data.customer_id !== customerId) return { status: 404, body: { toast: { message: "Subscription not found.", tone: "critical" } } };
  const sub = current.data as Subscription;
  if (body.action === "skip") {
    await subs(ctx).put(id, { ...sub, next_at: addDays(sub.next_at, sub.interval_days) }, { expectedRevision: current.revision });
  } else if (body.action === "cancel") {
    await subs(ctx).put(id, { ...sub, status: "cancelled" }, { expectedRevision: current.revision });
  } else {
    return { status: 400, body: { toast: { message: "Unknown action.", tone: "critical" } } };
  }
  await syncPortal(ctx, customerId);
  return { body: { toast: { message: body.action === "skip" ? "Next delivery skipped." : "Subscription cancelled.", tone: "success" } } };
}

export default definePlugin({
  manifest,
  events: {
    "order.created": (event, ctx) => captureSubscriptions(event.resource.id, ctx),
  },
  functions: {
    "checkout.discounts": ({ cart }, settings) => {
      const percent = Math.min(50, Math.max(1, Number(settings.percent_off ?? 10)));
      const lineIds = cart.lines.filter((line) => line.properties.subscribe === "30" || line.properties.subscribe === "60").map((line) => line.lineId);
      if (lineIds.length === 0) return { discounts: [] };
      return { discounts: [{ title: `Subscribe & save ${percent}%`, target: { kind: "lines" as const, lineIds }, value: { type: "percentage" as const, percent } }] };
    },
    "buyer.ui": ({ snapshot, customer }) => {
      const items = Array.isArray(snapshot?.data.items) ? snapshot.data.items as Array<{ id: string; title: string; next_at: string; every: number }> : [];
      if (!customer || items.length === 0) return { ui: null };
      return { ui: { type: "stack", children: [
        { type: "heading", text: "Your subscriptions" },
        ...items.slice(0, 10).map((item) => ({ type: "stack" as const, children: [
          { type: "key-value" as const, items: [{ label: item.title.slice(0, 120), value: `Next: ${item.next_at}, every ${item.every} days` }] },
          { type: "columns" as const, children: [
            { type: "button" as const, label: "Skip next", action: { kind: "app_route" as const, route: "manage", body: { id: item.id, action: "skip" } } },
            { type: "button" as const, label: "Cancel", action: { kind: "app_route" as const, route: "manage", body: { id: item.id, action: "cancel" } } },
          ] },
        ] })),
      ] } };
    },
  },
  routes: {
    public: { manage },
    admin: {
      overview: async (_request, ctx) => ({
        body: ui.page([
          ui.stat("Active subscriptions", await subs(ctx).count({ status: "active" })),
        ], { title: "Subscriptions" }),
      }),
    },
  },
  cron: {
    renew: async (ctx, { scheduledAt }) => {
      const today = scheduledAt.slice(0, 10);
      let cursor: string | null = null;
      // Free plan: 50 platform calls per run; a renewal costs four, so a run
      // places about ten renewals (DX-REPORT SUB-3).
      for (let placed = 0; placed < 10;) {
        const page = await subs(ctx).query({ where: { status: "active" }, orderBy: { field: "next_at", direction: "asc" }, limit: 10, cursor });
        for (const record of page.records) {
          if (String(record.data.next_at) > today) return;
          if (await renew(ctx, record.id, record.data as Subscription, record.revision) === "placed") placed += 1;
        }
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
      }
    },
  },
});
