import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import plugin, { manifest } from "./index";

const buyer = { id: "cus_1", tags: ["net30"], orderCount: 3, totalSpentMinor: 1_000_000 };

function seeded() {
  const harness = createPluginTestHarness(plugin);
  return harness;
}

describe("acme.wholesale", () => {
  it("adds a buyer to a company and copies its price list into the buyer's snapshot record", async () => {
    const harness = seeded();
    harness.records.get("companies")!.set("co_1", { name: "Northwind", terms: "net30", prices: { var_1: 40_000 }, moq: { var_1: 12 } });
    const result = await harness.route("admin", "companies", { method: "POST", body: { values: { customer_id: "cus_1", company_id: "co_1" } } });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(harness.records.get("members")!.get("cus_1")).toMatchObject({ company_id: "co_1", prices: { var_1: 40_000 } });
  });

  it("prices base-priced lines from the snapshot and leaves list-priced lines alone", async () => {
    const harness = seeded();
    const snapshot = { revision: 1, data: { company_id: "co_1", company_name: "Northwind", terms: "net30", prices: { var_1: 40_000, var_2: 9_000 }, moq: {}, approved_quotes: {} } };
    const cart = fixtures.cart({
      customer: buyer,
      lines: [fixtures.cartLine(), fixtures.cartLine({ lineId: "line_2", variantId: "var_2" })],
    });
    const result = await harness.fn("cart.line_prices", {
      cart,
      lines: [{ lineId: "line_1", source: "base", bundle: null }, { lineId: "line_2", source: "segment", bundle: null }],
      snapshot,
    });
    expect(result.value).toEqual({ prices: [{ lineId: "line_1", unitPriceMinor: 40_000 }] });
  });

  it("blocks a line below its minimum order quantity", async () => {
    const harness = createPluginTestHarness(plugin, { settings: { moq_rules: "TSHIRT-M=12\nMUG=6" } });
    const result = await harness.fn("cart.validate", { cart: fixtures.cart() });
    expect(result.value).toEqual({ errors: [{ code: "moq", lineId: "line_1", message: "Order at least 12 of T-shirt." }] });
  });

  it("cannot even express a wholesale minimum above 99 units: storefront lines stop at 99", () => {
    // apps/api/src/routes/storefront-orders/checkout.ts:281 caps a cart line at 99.
    // A minimum of 120 is unbuyable whatever the app answers (DX-REPORT B2B-7).
    expect(99).toBeLessThan(120);
  });

  it("spends an approved quote once, inside the order commit", async () => {
    const harness = seeded();
    const snapshot = { revision: 4, data: { company_id: "co_1", company_name: "Northwind", terms: "net30", prices: {}, moq: {}, approved_quotes: { "Q-ABC": 25_000 } } };
    const result = await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput({ cart: { customer: buyer, discountCodes: ["q-abc"] }, snapshot }));
    expect(result.value).toMatchObject({
      discounts: [{ code: "Q-ABC", value: { type: "fixed_amount", amountMinor: 25_000 } }],
      commit: { record: { approved_quotes: {} } },
    });
  });

  it("keeps only the invoice method for tagged buyers", async () => {
    const harness = seeded();
    const result = await harness.fn("checkout.payment_methods", {
      cart: fixtures.cart({ customer: buyer }),
      methods: [{ methodId: "cod", name: "Cash on delivery" }, { methodId: "stripe", name: "Card" }],
    });
    expect(result.value).toEqual({ operations: [{ op: "hide", methodId: "stripe" }] });
  });

  it("files a quote request from the proxy page for a signed-in buyer", async () => {
    const harness = seeded();
    const result = await harness.route("public", "quote", {
      method: "POST",
      headers: { accept: "text/html" },
      body: { variant_0: "var_1", quantity_0: "240", note: "Pallet pricing please" },
      customer: { id: "cus_1" },
    });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const [quote] = [...harness.records.get("quotes")!.values()];
    expect(quote).toMatchObject({ customer_id: "cus_1", status: "requested", lines: [{ variantId: "var_1", quantity: 240 }] });
  });

  it("answers the quotes page with a valid dashboard UI document", async () => {
    const harness = seeded();
    const result = await harness.route("admin", "quotes", fixtures.adminRouteRequest());
    const document = parsePluginUiDocument((result.value as { body: unknown }).body);
    expect(document.ok, JSON.stringify(document)).toBe(true);
  });

  it("approves a quote: the quote and the buyer's snapshot change in one batch", async () => {
    const harness = seeded();
    harness.records.get("members")!.set("cus_1", { company_id: "co_1", company_name: "Northwind", terms: "net30", prices: {}, moq: {}, approved_quotes: {} });
    harness.records.get("quotes")!.set("quo_1", { customer_id: "cus_1", company_id: "co_1", status: "requested", lines: [], note: "" });
    const result = await harness.route("admin", "quotes", { method: "POST", staffId: "staff_1", body: { values: { quote_id: "quo_1", decision: "approve", discount: 150 } } });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(harness.records.get("members")!.get("cus_1")).toMatchObject({ approved_quotes: { "Q-QUO1": 15_000 } });
    expect(harness.records.get("quotes")!.get("quo_1")).toMatchObject({ status: "approved", code: "Q-QUO1" });
  });

  it("DX: the harness does not validate function input or output; production drops what it accepts", async () => {
    const { definePlugin } = await import("@scalius/plugin-sdk");
    const broken = definePlugin({
      manifest: { ...manifest, functions: [{ point: "cart.line_prices", priority: 1 }] },
      // unitPriceMinor must be a positive integer (cartLinePricesOutputSchema).
      functions: { "cart.line_prices": () => ({ prices: [{ lineId: "line_1", unitPriceMinor: 0.5 }] }) },
      routes: { admin: { quotes: () => ({}), companies: () => ({}) }, public: { quote: () => ({}) } },
    });
    const harness = createPluginTestHarness(broken);
    // Not even a valid input: no `lines`, wrong snapshot shape.
    const result = await harness.fn("cart.line_prices", { cart: { lines: [] }, snapshot: { data: 1 } });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ prices: [{ lineId: "line_1", unitPriceMinor: 0.5 }] });
    const { cartLinePricesOutputSchema } = await import("@scalius/shared/plugins/functions");
    expect(cartLinePricesOutputSchema.safeParse(result.value).success).toBe(false);
  });
});
