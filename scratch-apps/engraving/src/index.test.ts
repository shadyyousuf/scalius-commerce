import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures } from "@scalius/plugin-sdk/testing";
import { fixtureProductPage, renderBlock, storefrontShown } from "@scalius/plugin-sdk/storefront/testing";
import plugin, { letters } from "./index";
import storefront from "./storefront";

describe("acme.engraving", () => {
  it("refuses engraving text with characters the workshop cannot cut", async () => {
    const harness = createPluginTestHarness(plugin);
    const cart = fixtures.cart({ lines: [fixtures.cartLine({ properties: { engraving: "Love <3 ✨" } })] });
    const result = await harness.fn("cart.validate", { cart });
    expect(result.value).toMatchObject({ errors: [{ code: "engraving.characters", lineId: "line_1" }] });
  });

  it("refuses blocked words and passes clean text", async () => {
    const harness = createPluginTestHarness(plugin, { settings: { blocked_words: "darn\nheck" } });
    const bad = await harness.fn("cart.validate", { cart: fixtures.cart({ lines: [fixtures.cartLine({ properties: { engraving: "Oh Heck" } })] }) });
    expect(bad.value).toMatchObject({ errors: [{ code: "engraving.blocked" }] });
    const good = await harness.fn("cart.validate", { cart: fixtures.cart({ lines: [fixtures.cartLine({ properties: { engraving: "For Ana, 2026" } })] }) });
    expect(good.value).toEqual({ errors: [] });
  });

  it("adds the per-letter price to base-priced engraved lines only", async () => {
    const harness = createPluginTestHarness(plugin, { settings: { per_letter: 20 } });
    const cart = fixtures.cart({ lines: [
      fixtures.cartLine({ properties: { engraving: "A B C" } }),
      fixtures.cartLine({ lineId: "line_2", properties: { engraving: "SALE" } }),
      fixtures.cartLine({ lineId: "line_3" }),
    ] });
    const result = await harness.fn("cart.line_prices", {
      cart,
      lines: [{ lineId: "line_1", source: "base", bundle: null }, { lineId: "line_2", source: "sale", bundle: null }, { lineId: "line_3", source: "base", bundle: null }],
    });
    // 3 letters x 20.00 BDT on top of 500.00; the sale line gets its engraving free (CFG-2).
    expect(result.value).toEqual({ prices: [{ lineId: "line_1", unitPriceMinor: 50_000 + 3 * 2_000 }] });
    expect(letters(" A  B C ")).toBe(3);
  });

  it("draws the preview only on engravable products, and the island survives the output check", () => {
    const page = fixtureProductPage({ fields: { "acme.engraving.engravable": true, "acme.engraving.max_letters": 12 } });
    const html = renderBlock(storefront, "preview", { plate: "#c9a227", label: "Your engraving" }, page, { target: "product.buy-box" });
    expect(html).toContain("data-engrave-text");
    expect(storefrontShown(html, "acme.engraving").dropped).toBe(0);
    expect(renderBlock(storefront, "preview", { plate: "#c9a227", label: "x" }, fixtureProductPage())).toBe("");
  });
});
