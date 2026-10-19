import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import { fixtureProductPage, renderBlock } from "@scalius/plugin-sdk/storefront/testing";
import plugin, { commission } from "./index";
import storefront from "./storefront";

const items = [
  { id: "it_1", productId: "prod_a", quantity: 2, productName: "Tea", lineSubtotalMinor: 60_000, discountAmountMinor: 0 },
  { id: "it_2", productId: "prod_b", quantity: 1, productName: "Pot", lineSubtotalMinor: 150_000, discountAmountMinor: 10_000 },
  { id: "it_3", productId: "prod_c", quantity: 1, productName: "House item", lineSubtotalMinor: 9_000, discountAmountMinor: 0 },
];

function harnessWithOrder(calls: string[] = []) {
  const harness = createPluginTestHarness(plugin, {
    api: async (operationId, input) => {
      calls.push(operationId);
      if (operationId === "dashboard.orders.get") return { ok: true, status: 200, error: null, data: { createdAt: "2026-10-03T08:00:00Z" } };
      if (operationId === "dashboard.orders.items") return { ok: true, status: 200, error: null, data: items };
      if (operationId === "dashboard.orders.fulfillment_create") return { ok: true, status: 201, error: null, data: { input } };
      return { ok: false, status: 404, data: null, error: { code: "api.unknown_operation", message: operationId } };
    },
  });
  harness.records.get("vendors")!.set("ven_1", { name: "Leaf & Co", email: "leaf@vendor.example", commission_bp: 1500, account_customer_id: "cus_v1" });
  harness.records.get("vendors")!.set("ven_2", { name: "Clayworks", email: "clay@vendor.example", commission_bp: 1000 });
  harness.customFields.set("product:prod_a", { vendor: "ven_1" });
  harness.customFields.set("product:prod_b", { vendor: "ven_2" });
  return harness;
}

describe("acme.market", () => {
  it("splits an order between its vendors once and tells each vendor", async () => {
    const harness = harnessWithOrder();
    const event = fixtures.event("order.created", { resource: { type: "order", id: "ord_9" } });
    const first = await harness.deliver(event);
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    expect((await harness.deliver(event)).ok).toBe(true);
    const records = harness.records.get("vendor_orders")!;
    expect([...records.keys()].sort()).toEqual(["ord_9:ven_1", "ord_9:ven_2"]);
    expect(records.get("ord_9:ven_2")).toMatchObject({ subtotal_minor: 140_000, commission_minor: 14_000, period: "2026-10" });
    // The redelivery's conflict stopped before the second round of emails.
    expect(harness.sent.emails).toHaveLength(2);
  });

  it("lets a vendor ship only their own lines from the proxy dashboard", async () => {
    const calls: string[] = [];
    const harness = harnessWithOrder(calls);
    await harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "ord_9" } }));
    const stranger = await harness.route("public", "vendor", { method: "POST", customer: { id: "cus_x" }, body: { order_id: "ord_9" } });
    expect((stranger.value as { status: number }).status).toBe(403);
    const vendor = await harness.route("public", "vendor", { method: "POST", customer: { id: "cus_v1" }, body: { order_id: "ord_9", courier: "Pathao", tracking: "T1" } });
    expect(vendor.ok, JSON.stringify(vendor.error)).toBe(true);
    expect(calls).toContain("dashboard.orders.fulfillment_create");
    expect(harness.records.get("vendor_orders")!.get("ord_9:ven_1")).toMatchObject({ status: "shipped" });
    expect(harness.records.get("vendor_orders")!.get("ord_9:ven_2")).toMatchObject({ status: "open" });
  });

  it("reports payouts per vendor and period", async () => {
    const harness = harnessWithOrder();
    await harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "ord_9" } }));
    const result = await harness.route("admin", "payouts", fixtures.adminRouteRequest({ query: { period: "2026-10" } }));
    const page = parsePluginUiDocument((result.value as { body: unknown }).body);
    expect(page.ok, JSON.stringify(page)).toBe(true);
    expect(JSON.stringify(result.value)).toContain('"payout":{"money":51000}');
  });

  it("computes commission in whole minor units", () => {
    expect(commission(140_000, 1000)).toBe(14_000);
    expect(commission(333, 1500)).toBe(50);
  });

  it("shows the vendor on the product page from a copied custom field", () => {
    const page = fixtureProductPage({ fields: { "acme.market.vendor_name": "Leaf & Co", "acme.market.vendor": "ven_1" } });
    expect(renderBlock(storefront, "sold-by", {}, page)).toContain("Leaf &amp; Co");
  });

  it("DX: the harness lets an app email anyone without read_customers; the host refuses (requireContactAccess)", async () => {
    // acme.market declares read_customers, so this would work either way; the
    // point is that removing the scope still passes in the harness.
    const { definePlugin } = await import("@scalius/plugin-sdk");
    const { manifest } = await import("./index");
    const mailer = definePlugin({
      manifest: { ...manifest, scopes: [], events: ["order.created"], objects: {}, customFields: [], timeline: [], routes: { admin: [], public: [], webhooks: [] }, admin: { pages: [] }, storefront: {} },
      events: { "order.created": async (_event, ctx) => { await ctx.messaging.email({ to: "anyone@elsewhere.example", subject: "Hi", html: "<p>Hi</p>" }); } },
    });
    const harness = createPluginTestHarness(mailer);
    const result = await harness.deliver(fixtures.event("order.created"));
    expect(result.ok).toBe(true);
    expect(harness.sent.emails).toHaveLength(1);
  });
});
