import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures } from "@scalius/plugin-sdk/testing";
import { fixtureProductPage, renderBlock } from "@scalius/plugin-sdk/storefront/testing";
import plugin, { addDays, renewalKey } from "./index";
import storefront from "./storefront";

function api(calls: string[]) {
  return async (operationId: string, input: unknown) => {
    calls.push(operationId);
    if (operationId === "dashboard.orders.get") {
      return { ok: true, status: 200, error: null, data: { customerRecord: { id: "cus_1", kind: "account" }, createdAt: "2026-10-01T10:00:00Z", channelSource: null } };
    }
    if (operationId === "dashboard.orders.items") {
      return { ok: true, status: 200, error: null, data: [
        { id: "item_1", productId: "prod_1", variantId: "var_1", quantity: 2, productName: "Coffee beans", properties: [{ key: "subscribe", value: "30" }] },
        { id: "item_2", productId: "prod_2", variantId: "var_2", quantity: 1, productName: "Mug", properties: [] },
      ] };
    }
    if (operationId === "dashboard.customers.get") {
      return { ok: true, status: 200, error: null, data: { id: "cus_1", name: "Rahim", email: null, phone: "+8801711000000", addresses: [{ isDefault: true, countryCode: "BD", line1: "House 1", locality: "Dhaka", adminArea: null, postalCode: null }] } };
    }
    if (operationId === "dashboard.orders.create") {
      return { ok: true, status: 201, error: null, data: { id: "ord_r1", input } };
    }
    return { ok: false, status: 404, data: null, error: { code: "api.unknown_operation", message: operationId } };
  };
}

describe("acme.subscribe", () => {
  it("turns a subscribed line into a subscription once, however often the event arrives", async () => {
    const calls: string[] = [];
    const harness = createPluginTestHarness(plugin, { api: api(calls) });
    const event = fixtures.event("order.created", { resource: { type: "order", id: "ord_1" } });
    expect((await harness.deliver(event)).ok).toBe(true);
    expect((await harness.deliver(event)).ok).toBe(true);
    const all = [...harness.records.get("subscriptions")!.entries()];
    expect(all).toHaveLength(1);
    expect(all[0]![1]).toMatchObject({ customer_id: "cus_1", variant_id: "var_1", interval_days: 30, next_at: "2026-10-31", status: "active" });
    expect(harness.records.get("portals")!.get("cus_1")).toMatchObject({ items: [{ title: "Coffee beans", next_at: "2026-10-31" }] });
  });

  it("discounts subscribed lines only", async () => {
    const harness = createPluginTestHarness(plugin);
    const cart = fixtures.cart({ lines: [fixtures.cartLine({ properties: { subscribe: "30" } }), fixtures.cartLine({ lineId: "line_2" })] });
    const result = await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput({ cart }));
    expect(result.value).toEqual({ discounts: [{ title: "Subscribe & save 10%", target: { kind: "lines", lineIds: ["line_1"] }, value: { type: "percentage", percent: 10 } }] });
  });

  it("renews what is due and moves the next date", async () => {
    const calls: string[] = [];
    const harness = createPluginTestHarness(plugin, { api: api(calls) });
    harness.records.get("subscriptions")!.set("sub_a", { customer_id: "cus_1", product_id: "prod_1", variant_id: "var_1", title: "Beans", quantity: 1, interval_days: 30, next_at: "2026-10-01", status: "active", cycle: 0, source_order: "ord_1" });
    harness.records.get("subscriptions")!.set("sub_b", { customer_id: "cus_1", product_id: "prod_1", variant_id: "var_1", title: "Beans", quantity: 1, interval_days: 30, next_at: "2026-12-01", status: "active", cycle: 0, source_order: "ord_1" });
    const result = await harness.cron("renew", "2026-10-02T00:00:00.000Z");
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(calls.filter((call) => call === "dashboard.orders.create")).toHaveLength(1);
    expect(harness.records.get("subscriptions")!.get("sub_a")).toMatchObject({ cycle: 1, next_at: "2026-10-31" });
    expect(harness.records.get("subscriptions")!.get("sub_b")).toMatchObject({ cycle: 0 });
  });

  it("lets only the owner skip or cancel from the account page", async () => {
    const harness = createPluginTestHarness(plugin);
    harness.records.get("subscriptions")!.set("sub_a", { customer_id: "cus_1", product_id: "prod_1", variant_id: "var_1", title: "Beans", quantity: 1, interval_days: 30, next_at: "2026-10-01", status: "active", cycle: 0, source_order: "ord_1" });
    const stranger = await harness.route("public", "manage", { method: "POST", body: { id: "sub_a", action: "cancel" }, customer: { id: "cus_2" } });
    expect((stranger.value as { status: number }).status).toBe(404);
    const owner = await harness.route("public", "manage", { method: "POST", body: { id: "sub_a", action: "skip" }, customer: { id: "cus_1" } });
    expect(owner.ok).toBe(true);
    expect(harness.records.get("subscriptions")!.get("sub_a")).toMatchObject({ next_at: "2026-10-31", status: "active" });
  });

  it("derives a stable UUID per renewal", async () => {
    expect(await renewalKey("sub_a", 1)).toBe(await renewalKey("sub_a", 1));
    expect(await renewalKey("sub_a", 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(addDays("2026-12-15", 30)).toBe("2027-01-14");
  });

  it("draws the product block only for products marked subscribable", () => {
    const page = fixtureProductPage();
    expect(renderBlock(storefront, "subscribe-note", { text: "Save" }, page)).toBe("");
    const marked = { product: { ...page.product, fields: { "acme.subscribe.offered": true } } };
    expect(renderBlock(storefront, "subscribe-note", { text: "Save" }, marked)).toContain("Save");
  });
});
