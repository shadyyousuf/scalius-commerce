import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures } from "@scalius/plugin-sdk/testing";
import { renderSection } from "@scalius/plugin-sdk/storefront/testing";
import plugin, { referralCodeFor } from "./index";
import storefront from "./storefront";

const signedIn = (orderCount: number) => ({ id: "cus_new", tags: [], orderCount, totalSpentMinor: 0 });

function withOrder(order: Record<string, unknown>) {
  return createPluginTestHarness(plugin, {
    api: async () => ({ ok: true, status: 200, error: null, data: order }),
  });
}

describe("acme.rewards", () => {
  it("earns points once per paid order and credits the referrer", async () => {
    const harness = withOrder({ customerRecord: { id: "cus_new", kind: "account" }, totalAmountMinor: 200_000, discounts: [{ code: "REF-CUSOLD1" }] });
    harness.records.get("balances")!.set("cus_old1", { points: 10, earned: 10, spent: 0, referral_code: "REF-CUSOLD1" });
    const event = fixtures.event("order.paid", { resource: { type: "order", id: "ord_1" } });
    const first = await harness.deliver(event);
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    expect((await harness.deliver(event)).ok).toBe(true);
    expect(harness.records.get("balances")!.get("cus_new")).toMatchObject({ points: 100, earned: 100 });
    expect(harness.records.get("balances")!.get("cus_old1")).toMatchObject({ points: 210 });
  });

  it("gives a friend's first order the referral discount, but not the referrer's own code", async () => {
    const harness = createPluginTestHarness(plugin);
    const friend = await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput({ cart: { customer: signedIn(0), discountCodes: ["ref-cusold1"] } }));
    expect(friend.value).toMatchObject({ discounts: [{ title: "Referral discount", value: { percent: 10 } }] });
    const self = await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput({ cart: { customer: signedIn(0), discountCodes: [referralCodeFor("cus_new")] } }));
    expect(self.value).toEqual({ discounts: [] });
    const repeat = await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput({ cart: { customer: signedIn(3), discountCodes: ["REF-CUSOLD1"] } }));
    expect(repeat.value).toEqual({ discounts: [] });
  });

  it("redeems points atomically with the order", async () => {
    const harness = createPluginTestHarness(plugin);
    const result = await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput({
      cart: { customer: signedIn(2), discountCodes: ["POINTS"] },
      snapshot: { revision: 3, data: { points: 300, earned: 300, spent: 0, referral_code: "REF-CUSNEW" } },
    }));
    // 1,000.00 of items at 1.00 a point: all 300 points are spent.
    expect(result.value).toMatchObject({ discounts: [{ value: { amountMinor: 30_000 } }], commit: { record: { points: 0, spent: 300 } } });
  });

  it("answers the balance badge for signed-in buyers only", async () => {
    const harness = createPluginTestHarness(plugin);
    harness.records.get("balances")!.set("cus_1", { points: 42, earned: 42, spent: 0, referral_code: "REF-CUS1" });
    expect((await harness.route("public", "balance", { customer: { id: "cus_1" } })).value).toEqual({ body: { signedIn: true, points: 42 } });
    expect((await harness.route("public", "balance", {})).value).toEqual({ body: { signedIn: false } });
  });

  it("renders the badge section without buyer data", () => {
    const html = renderSection(storefront, "points-badge", { label: "Your points" });
    expect(html).toContain("data-points");
    expect(html).toContain("hidden");
  });
});
