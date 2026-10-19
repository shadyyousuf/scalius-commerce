import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import {
  fixtureHeaderData,
  fixtureProductCard,
  renderHeader,
  renderProductCard,
  renderSection,
  renderSkin,
  storefrontShown,
} from "@scalius/plugin-sdk/storefront/testing";
import plugin from "./index";
import storefront from "./storefront";

const menu = [
  { title: "Women", url: "/categories/women", children: [
    { title: "Dresses", url: "/categories/dresses", children: [{ title: "Midi", url: "/categories/midi", children: [] }] },
    { title: "Knitwear", url: "/categories/knitwear", children: [] },
  ] },
  { title: "Journal", url: "/journal", children: [] },
];

describe("acme.atelier", () => {
  it("parses as an app (a theme is an app with no handlers)", () => {
    expect(createPluginTestHarness(plugin).manifest.storefront.skins).toHaveLength(3);
  });

  it("draws a mega-menu header that meets the header contract", () => {
    const html = renderHeader(storefront, "atelier-header", { sticky: true, promo_title: "Autumn", promo_link: "/collections" }, fixtureHeaderData({ menu }), { islands: ["gallery"] });
    expect(html).toContain('aria-controls="atelier-mega-0"');
    expect(html).toContain("data-menu-drawer");
    expect(storefrontShown(html, "acme.atelier").dropped).toBe(0);
  });

  it("draws the card with a hover photo and quick add", () => {
    const html = renderProductCard(storefront, "atelier-card", { show_rating: true }, fixtureProductCard({ quickAdd: true }));
    expect(html).toContain("data-card-quick-add");
  });

  it("draws the product page around the required buy form, with its own gallery or the store's", () => {
    const stacked = renderSkin(storefront, "atelier-pdp", "product-main", { gallery: "stacked" });
    expect(stacked).toContain('kind="buy-form"');
    expect(stacked).not.toContain('kind="gallery"');
    const core = renderSkin(storefront, "atelier-pdp", "product-main", { gallery: "core" });
    expect(core).toContain('kind="gallery"');
  });

  it("draws the lookbook from list settings and skips an empty one", () => {
    expect(renderSection(storefront, "lookbook", { heading: "Lookbook", looks: [], products: [] })).toBe("");
    const html = renderSection(storefront, "lookbook", {
      heading: "Lookbook",
      looks: [{ photo: null, title: "Rust & linen", text: "Layers for the first cold week.", link: "/collections/autumn" }],
      products: [fixtureProductCard()],
    });
    expect(html).toContain("Rust &amp; linen");
  });
});
