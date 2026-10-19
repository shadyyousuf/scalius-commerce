import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures } from "@scalius/plugin-sdk/testing";
import plugin, { hmacHex } from "./index";

const SECRET = "whsec_9f8e7d6c5b4a3210";

async function signed(body: unknown, delivery = "dlv_00000001") {
  const rawBody = JSON.stringify(body);
  return { method: "POST", rawBody, body, headers: { "x-erp-signature": await hmacHex(SECRET, rawBody), "x-erp-delivery": delivery } };
}

function harness(calls: Array<{ op: string; input: unknown }> = []) {
  const value = createPluginTestHarness(plugin, {
    settings: { webhook_secret: SECRET, erp_token: "tok_live_abcdef" },
    api: async (op, input) => {
      calls.push({ op, input });
      if (op === "dashboard.product_variants.list") return { ok: true, status: 200, error: null, data: { variants: [{ id: "var_1", productId: "prod_1", sku: "MUG-01", price: 500, weight: 300, imageId: null, selectedOptions: [] }] } };
      if (op === "dashboard.products.get_section") return { ok: true, status: 200, error: null, data: { aggregateRevision: 7 } };
      return { ok: true, status: 200, error: null, data: {} };
    },
    fetch: async () => ({ status: 201, body: "{}" }),
  });
  return value;
}

describe("acme.erp", () => {
  it("refuses an unsigned delivery and changes nothing", async () => {
    const h = harness();
    const result = await h.route("webhooks", "stock", { method: "POST", rawBody: "{}", body: {}, headers: { "x-erp-signature": "00", "x-erp-delivery": "dlv_00000001" } });
    expect((result.value as { status: number }).status).toBe(401);
    expect(h.records.get("jobs")!.size).toBe(0);
  });

  it("queues a signed delivery once and keeps the newest change per SKU", async () => {
    const h = harness();
    const first = await h.route("webhooks", "stock", await signed({ lines: [{ sku: "MUG-01", seq: 5, onHand: 12 }, { sku: "MUG-01", seq: 4, onHand: 99 }] }));
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    const again = await h.route("webhooks", "stock", await signed({ lines: [{ sku: "MUG-01", seq: 5, onHand: 12 }] }));
    expect((again.value as { body: unknown }).body).toEqual({ duplicate: true });
    expect(h.records.get("jobs")!.get("sku:mug-01")).toMatchObject({ seq: 5, on_hand: 12, state: "pending" });
  });

  it("applies stock and price with idempotency keys, and parks unknown SKUs", async () => {
    const calls: Array<{ op: string; input: unknown }> = [];
    const h = harness(calls);
    await h.deliver(fixtures.event("product.created", { resource: { type: "product", id: "prod_1" } }));
    await h.route("webhooks", "stock", await signed({ lines: [{ sku: "MUG-01", seq: 9, onHand: 3, price: 650 }, { sku: "NOPE", seq: 10, onHand: 1 }] }));
    const result = await h.cron("apply");
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const stock = calls.find((call) => call.op === "dashboard.inventory.set_stock")!.input as { idempotencyKey: string; body: unknown };
    expect(stock.body).toEqual({ variantId: "var_1", newStock: 3, reason: "ERP sync" });
    expect(stock.idempotencyKey).toBe("erp-MUG-01-90000");
    const price = calls.find((call) => call.op === "dashboard.product_variants.update")!.input as { body: { price: number; expectedAggregateRevision: number } };
    expect(price.body).toMatchObject({ price: 650, expectedAggregateRevision: 7 });
    expect(h.records.get("jobs")!.has("sku:mug-01")).toBe(false);
    expect(h.records.get("jobs")!.get("sku:nope")).toMatchObject({ state: "unknown_sku" });
  });

  it("sends each new order to the ERP with the event id as its idempotency key", async () => {
    const sent: Array<{ url: string; init: unknown }> = [];
    const h = createPluginTestHarness(plugin, {
      settings: { webhook_secret: SECRET, erp_token: "tok_live_abcdef" },
      api: async () => ({ ok: true, status: 200, error: null, data: [] }),
      fetch: async (url, init) => { sent.push({ url, init }); return { status: 201, body: "{}" }; },
    });
    const result = await h.deliver(fixtures.event("order.created", { id: "evt_77", resource: { type: "order", id: "ord_1" } }));
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(sent[0]!.url).toBe("https://erp.acme.example/v1/sales-orders");
    expect(JSON.stringify(sent[0]!.init)).toContain('"idempotency-key":"evt_77"');
  });
});
