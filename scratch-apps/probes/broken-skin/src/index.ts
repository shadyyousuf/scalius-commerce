// Probe: a product-main skin without the required buy form, and a custom
// field with a type that does not exist. `pnpm plugin validate` says
// "ready to pack"; `pnpm plugin pack` refuses (DX-REPORT DX-4).
import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.probe",
  name: "Probe",
  version: "0.0.1",
  apiVersion: PLUGIN_API_VERSION,
  description: "Probe for the validator.",
  author: { name: "Acme" },
  customFields: [{ ownerType: "product", key: "colour", name: "Colour", type: "colour_hex" }],
  storefront: { skins: [{ id: "pdp", target: "product-main", name: "PDP", settings: [] }] },
} satisfies PluginManifestInput;

export default definePlugin({ manifest });
