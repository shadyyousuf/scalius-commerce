// acme.erp: a third-party ERP sync. Stock and price updates arrive by signed
// webhook, are queued durably and applied idempotently; new orders go out to
// the ERP. Public SDK only; hacks are marked.
//
// Throughput (DX-REPORT ERP-1): one stable write moves one SKU
// (dashboard.inventory.set_stock), an app makes 60 API calls a minute and 50
// per run on Free, and cron runs every 15 (Paid) or 23 (Free) minutes. A
// 10,000-SKU stock file therefore takes at least 167 minutes of API budget,
// and on Free about 3.5 days of cron runs.

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput, type PluginRouteRequest } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.erp",
  name: "ERP sync",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Keeps stock and prices in step with your ERP and sends it every new order.",
  author: { name: "Acme" },
  categories: ["inventory", "operations"],
  support: { email: "support@acme.example" },
  scopes: ["read_products", "write_products", "read_inventory", "write_inventory", "read_orders"],
  allowedHosts: ["erp.acme.example"],
  events: ["order.created", "product.created", "product.updated"],
  objects: {
    // ERP deliveries already accepted, by the ERP's delivery id.
    inbox: {
      name: "ERP deliveries",
      admin: "read",
      fields: [{ key: "received_at", name: "Received", type: "date_time", required: true }, { key: "lines", name: "Lines", type: "integer" }],
    },
    // One pending change per SKU: a newer delivery replaces an older one (last write wins by ERP sequence).
    jobs: {
      name: "Pending ERP changes",
      admin: "read",
      fields: [
        { key: "sku", name: "SKU", type: "single_line_text", required: true },
        { key: "seq", name: "ERP sequence", type: "integer", required: true },
        { key: "on_hand", name: "On hand", type: "integer" },
        { key: "price_minor", name: "Price (minor units)", type: "integer" },
        { key: "state", name: "State", type: "single_line_text", validations: { choices: ["pending", "unknown_sku"] } },
      ],
      indexes: [["state", "seq"]],
    },
    // HACK: no stable operation finds a variant by SKU (only by barcode), so
    // the app mirrors the store's SKU -> variant map from product events.
    skus: {
      name: "SKU map",
      admin: "none",
      fields: [{ key: "variant_id", name: "Variant", type: "variant_reference", required: true }, { key: "product_id", name: "Product", type: "product_reference", required: true }],
    },
  },
  settings: [
    { key: "webhook_secret", label: "ERP webhook secret", type: "secret", required: true },
    { key: "erp_token", label: "ERP API token", type: "secret", required: true },
  ],
  routes: { admin: [], public: [], webhooks: ["stock"] }, // admin and public routes are { name, methods }; webhooks are bare names (DX-REPORT DX-6)
  cron: [{ name: "apply", schedule: "*/15 * * * *" }],
} satisfies PluginManifestInput;

export interface ErpLine { sku: string; seq: number; onHand?: number; price?: number }

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

const jobId = (sku: string) => `sku:${sku.trim().toLowerCase()}`.slice(0, 128);

async function receive(request: PluginRouteRequest, ctx: PluginContext) {
  const secret = typeof ctx.settings.webhook_secret === "string" ? ctx.settings.webhook_secret : "";
  if (!secret || request.rawBody === null) return { status: 503, body: { error: "not_configured" } };
  const signature = request.headers["x-erp-signature"] ?? "";
  if (!equal(signature, await hmacHex(secret, request.rawBody))) return { status: 401, body: { error: "bad_signature" } };
  const delivery = request.headers["x-erp-delivery"] ?? "";
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(delivery)) return { status: 400, body: { error: "missing_delivery_id" } };
  if (await ctx.objects.inbox!.get(delivery)) return { status: 200, body: { duplicate: true } };
  const payload = request.body as { lines?: ErpLine[] } | null;
  const valid = Array.isArray(payload?.lines) ? payload.lines.filter((line) => typeof line.sku === "string" && Number.isSafeInteger(line.seq)) : [];
  // A batch writes each record once, so a delivery naming a SKU twice keeps its newest line.
  const newest = new Map<string, ErpLine>();
  for (const line of valid) if ((newest.get(jobId(line.sku))?.seq ?? -1) < line.seq) newest.set(jobId(line.sku), line);
  const lines = [...newest.values()];
  // Queue first, answer fast. A batch holds 25 writes, one for the inbox, so
  // a delivery queues 24 SKUs per batch; the rest go in further batches and a
  // retry of the delivery re-queues them idempotently (seq guards order).
  for (let start = 0; start < lines.length; start += 24) {
    const chunk = lines.slice(start, start + 24);
    const current = await Promise.all(chunk.map((line) => ctx.objects.jobs!.getVersion(jobId(line.sku))));
    const writes = chunk.flatMap((line, index) => {
      const existing = current[index];
      if (existing && Number(existing.data.seq) >= line.seq) return [];
      const record: Record<string, unknown> = { sku: line.sku, seq: line.seq, state: "pending" };
      if (Number.isSafeInteger(line.onHand) && line.onHand! >= 0) record.on_hand = line.onHand;
      if (typeof line.price === "number" && line.price > 0) record.price_minor = Math.round(line.price * 10 ** ctx.store.decimalPlaces);
      return [{ op: "put" as const, object: "jobs", id: jobId(line.sku), record, expectedRevision: existing?.revision ?? null }];
    });
    if (writes.length > 0) await ctx.objects.batch(writes);
  }
  await ctx.objects.inbox!.put(delivery, { received_at: new Date().toISOString(), lines: lines.length }, { expectedRevision: null });
  return { status: 202, body: { queued: lines.length } };
}

interface Variant { id: string; productId: string; sku: string; price: number; weight: number | null; imageId: string | null; selectedOptions: Array<{ optionValueId: string }> }

async function mirrorSkus(productId: string, ctx: PluginContext): Promise<void> {
  const result = await ctx.api.call<{ variants: Variant[] }>("dashboard.product_variants.list", { path: { id: productId } });
  if (!result.ok || !result.data) { if (result.status >= 500) throw new Error("retry"); return; }
  const writes = result.data.variants.slice(0, 25).map((variant) => ({
    op: "put" as const, object: "skus", id: variant.sku.trim().toLowerCase().slice(0, 128), record: { variant_id: variant.id, product_id: productId },
  }));
  if (writes.length > 0) await ctx.objects.batch(writes);
}

/** Applies queued changes within this run's platform-call budget. */
async function apply(ctx: PluginContext, budget = 40): Promise<number> {
  let calls = 0;
  let applied = 0;
  const page = await ctx.objects.jobs!.query({ where: { state: "pending" }, orderBy: { field: "seq", direction: "asc" }, limit: 50 });
  for (const job of page.records) {
    if (calls >= budget) break;
    const sku = String(job.data.sku);
    const mapped = await ctx.objects.skus!.get(sku.trim().toLowerCase());
    if (!mapped) {
      await ctx.objects.jobs!.update(job.id, { state: "unknown_sku" }, { expectedRevision: job.revision });
      continue;
    }
    if (typeof job.data.on_hand === "number") {
      calls += 1;
      const result = await ctx.api.call("dashboard.inventory.set_stock", {
        // The ERP sequence makes the key: a replay after a lost answer applies once.
        // HACK: ctx.api.call documents keys of 8-200 characters; this operation
        // wants 16-128 matching /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ (DX-REPORT API-1).
        idempotencyKey: `erp-${sku}-${String(job.data.seq)}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128).padEnd(16, "0"),
        body: { variantId: String(mapped.variant_id), newStock: job.data.on_hand, reason: "ERP sync" },
      });
      if (!result.ok) { ctx.log.warn("Stock refused", { sku, code: result.error?.code }); continue; }
    }
    if (typeof job.data.price_minor === "number") {
      // HACK: a price change rewrites the whole SKU: the operation requires
      // options, image, weight, SKU and the product's aggregate revision, so
      // the app reads first and loses to any concurrent merchant edit
      // (DX-REPORT ERP-2). Price is decimal major units on the way in.
      calls += 2;
      const product = await ctx.api.call<{ aggregateRevision: number }>("dashboard.products.get_section", { path: { id: String(mapped.product_id), section: "base" } }); // was "core": the harness accepted it, the contract enum does not (DX-REPORT DX-2)
      const variants = await ctx.api.call<{ variants: Variant[] }>("dashboard.product_variants.list", { path: { id: String(mapped.product_id) } });
      const variant = variants.data?.variants.find((entry) => entry.id === mapped.variant_id);
      if (!product.ok || !product.data || !variant) continue;
      calls += 1;
      // No idempotencyKey: this operation has `idempotency: none`, and passing
      // one is refused (idempotency_not_supported). It is revision-guarded instead.
      const result = await ctx.api.call(`dashboard.product_variants.update`, {
        path: { id: String(mapped.product_id), variantId: variant.id },
        body: {
          selectedOptionValueIds: variant.selectedOptions.map((option) => option.optionValueId),
          imageId: variant.imageId, weight: variant.weight, sku: variant.sku,
          price: job.data.price_minor / 10 ** ctx.store.decimalPlaces,
          expectedAggregateRevision: product.data.aggregateRevision,
        },
      });
      if (!result.ok) { ctx.log.warn("Price refused", { sku, code: result.error?.code }); continue; }
    }
    await ctx.objects.jobs!.delete(job.id, { expectedRevision: job.revision });
    applied += 1;
  }
  return applied;
}

export default definePlugin({
  manifest,
  routes: { webhooks: { stock: receive } },
  cron: { apply: (ctx) => apply(ctx).then(() => undefined) },
  events: {
    "product.created": (event, ctx) => mirrorSkus(event.resource.id, ctx),
    "product.updated": (event, ctx) => mirrorSkus(event.resource.id, ctx),
    "order.created": async (event, ctx) => {
      const order = await ctx.api.call<{ orderNumber: string; totalAmountMinor: number; currencyCode: string }>("dashboard.orders.get", { path: { id: event.resource.id } });
      const items = await ctx.api.call<Array<{ variantId: string | null; quantity: number; unitPriceMinor: number | null }>>("dashboard.orders.items", { path: { id: event.resource.id } });
      if (!order.ok || !order.data || !items.ok || !items.data) throw new Error("retry");
      const response = await ctx.http.fetch("https://erp.acme.example/v1/sales-orders", {
        method: "POST",
        headers: { authorization: `Bearer ${String(ctx.settings.erp_token ?? "")}`, "content-type": "application/json", "idempotency-key": event.id },
        body: JSON.stringify({ number: order.data.orderNumber, currency: order.data.currencyCode, totalMinor: order.data.totalAmountMinor, lines: items.data }),
      });
      if (response.status >= 500 || response.status === 429) throw new Error(`ERP ${response.status}; retried`);
    },
  },
});

export { apply, receive };
