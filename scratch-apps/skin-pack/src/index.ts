// acme.atelier: a skin pack. A header with a mega-menu, a product card, a
// product page with its own gallery, a landing section with its own schema
// and one template. The cart drawer upsell is not here: the drawer is core
// and has no skin or slot (DX-REPORT THM-3).

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.atelier",
  name: "Atelier theme",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "An editorial theme: a mega-menu header, tall product cards, a stacked product gallery and a lookbook landing section.",
  author: { name: "Acme" },
  categories: ["store-design"],
  support: { email: "support@acme.example" },
  storefront: {
    skins: [
      {
        id: "atelier-header", target: "header", name: "Atelier header",
        settings: [
          { key: "sticky", label: "Stay on screen while scrolling", type: "boolean", default: true },
          // HACK: a skin's settings may not use `image` (it "reads nothing"),
          // so the mega-menu promo picture is a file shipped in the app and the
          // merchant can change only its words and link (DX-REPORT THM-1).
          { key: "promo_title", label: "Menu promotion title", type: "text", default: "The autumn edit", maxLength: 60 },
          { key: "promo_link", label: "Menu promotion link", type: "link", default: "/collections" },
        ],
      },
      {
        id: "atelier-card", target: "product-card", name: "Atelier card",
        settings: [{ key: "show_rating", label: "Show rating", type: "boolean", default: true }],
      },
      {
        id: "atelier-pdp", target: "product-main", name: "Atelier product page",
        settings: [{ key: "gallery", label: "Gallery", type: "select", default: "stacked", options: [{ value: "stacked", label: "Stacked photos" }, { value: "core", label: "Store gallery" }] }],
      },
    ],
    sections: [{
      type: "lookbook",
      name: "Lookbook",
      description: "A full-bleed photo story: looks, each with its photo, words and the products in it.",
      settings: [
        { key: "heading", label: "Heading", type: "text", default: "Lookbook", maxLength: 80 },
        {
          key: "looks", label: "Looks", type: "list", itemLabel: "Look", max: 6,
          fields: [
            { key: "photo", label: "Photo", type: "image" },
            { key: "title", label: "Title", type: "text", required: true, maxLength: 80 },
            { key: "text", label: "Text", type: "textarea", maxLength: 400 },
            { key: "link", label: "Link", type: "link" },
          ],
        },
        // HACK: a list item may not hold products ("items of the fields above (no
        // products)"), so a look cannot name its own products; one shared rail it is.
        { key: "products", label: "Shop the looks", type: "products", default: "newest", limit: 8 },
      ],
    }],
    templates: [{
      id: "atelier",
      name: "Atelier",
      description: "The Atelier header, card and product page with a lookbook on the homepage.",
      theme: {
        apps: {
          skins: {
            header: { app: "acme.atelier/atelier-header", values: {} },
            "product-card": { app: "acme.atelier/atelier-card", values: {} },
            "product-main": { app: "acme.atelier/atelier-pdp", values: {} },
          },
        },
        sections: [{ id: "app-atelier-lookbook", type: "app", version: 1, settings: { app: "acme.atelier/lookbook", values: {} } }],
      },
    }],
    islands: [{ name: "gallery", description: "Follows the chosen variant's photo in the stacked gallery." }],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

export default definePlugin({ manifest });
