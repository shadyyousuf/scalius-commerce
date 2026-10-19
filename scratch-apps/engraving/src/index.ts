// acme.engraving: a custom engraving with a live preview, a per-letter price
// add-on and checkout validation. Public SDK only; hacks are marked.
//
// The merchant adds two buyer inputs (product customization) to engravable
// products: `engraving` (text, 24 characters) and `font` (select). HACK: an
// app cannot declare or read a product's buyer inputs (DX-REPORT CFG-1), so
// the keys are a convention between the app and the merchant.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const ENGRAVING_KEY = "engraving";
export const FONT_KEY = "font";
export const ALLOWED = /^[\p{L}\p{N} .,'&!?-]*$/u;

export const manifest = {
  id: "acme.engraving",
  name: "Engraving",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Buyers personalise products with an engraving they preview live; you charge per letter and only valid text reaches the order.",
  author: { name: "Acme" },
  categories: ["checkout", "pricing"],
  support: { email: "support@acme.example" },
  customFields: [
    { ownerType: "product", key: "engravable", name: "Engravable", type: "boolean", storefrontVisible: true },
    { ownerType: "product", key: "max_letters", name: "Most letters", type: "integer", storefrontVisible: true },
  ],
  functions: [
    { point: "cart.validate", priority: 10, onError: "block" },
    { point: "cart.line_prices", priority: 20 },
  ],
  settings: [
    { key: "per_letter", label: "Price per letter", type: "number", min: 0, max: 10000, default: 20, help: "In your store currency." },
    { key: "blocked_words", label: "Words that cannot be engraved (one per line)", type: "textarea", default: "", maxLength: 5000 },
  ],
  storefront: {
    productBlocks: [{
      type: "preview",
      name: "Engraving preview",
      placement: "buy-box",
      settings: [
        { key: "plate", label: "Plate colour", type: "color", default: "#c9a227" },
        { key: "label", label: "Heading", type: "text", default: "Your engraving", maxLength: 60 },
      ],
    }],
    islands: [{ name: "preview", description: "Draws the engraving as the buyer types it." }],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

export function letters(text: string): number {
  return [...text.replace(/\s+/g, "")].length;
}

export function blockedWords(setting: unknown): string[] {
  return String(setting ?? "").split(/\r?\n/).map((word) => word.trim().toLowerCase()).filter(Boolean);
}

export default definePlugin({
  manifest,
  functions: {
    "cart.validate": ({ cart }, settings) => {
      const blocked = blockedWords(settings.blocked_words);
      const errors = cart.lines.flatMap((line) => {
        const text = line.properties[ENGRAVING_KEY];
        if (text === undefined || text === "") return [];
        if (!ALLOWED.test(text)) return [{ code: "engraving.characters", lineId: line.lineId, message: "Use letters, numbers and simple punctuation in the engraving." }];
        const lower = text.toLowerCase();
        if (blocked.some((word) => lower.includes(word))) return [{ code: "engraving.blocked", lineId: line.lineId, message: "We can't engrave that text. Please change it." }];
        // HACK: the product's own letter limit (a custom field) is not in the
        // function input, so only the buyer input's maxLength applies.
        return [];
      });
      return { errors: errors.slice(0, 20) };
    },
    "cart.line_prices": ({ cart, lines }, settings) => {
      const perLetterMinor = Math.round(Number(settings.per_letter ?? 0) * 10 ** cart.decimalPlaces);
      if (perLetterMinor <= 0) return { prices: [] };
      const sources = new Map(lines.map((line) => [line.lineId, line.source]));
      return {
        prices: cart.lines.flatMap((line) => {
          const count = letters(line.properties[ENGRAVING_KEY] ?? "");
          // HACK: an add-on is modelled as a new unit price, and only fx/base
          // lines take an app price: on a product in a sale or price list the
          // engraving is free (DX-REPORT CFG-2). `unitPriceMinor` is the price
          // before buyer-input surcharges, so this does not double count them.
          const source = sources.get(line.lineId);
          if (count === 0 || (source !== "base" && source !== "fx")) return [];
          return [{ lineId: line.lineId, unitPriceMinor: line.unitPriceMinor + count * perLetterMinor }];
        }),
      };
    },
  },
});
