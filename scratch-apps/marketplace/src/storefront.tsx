import { defineStorefront, t, type BlockProps } from "@scalius/plugin-sdk/storefront";

function SoldBy({ data, context }: BlockProps) {
  const name = data.product.fields["acme.market.vendor_name"];
  if (typeof name !== "string" || name.trim() === "") return null;
  return <p class="acme-sold-by">{t(context, { en: "Sold by", bn: "বিক্রেতা" })} <strong>{name}</strong></p>;
}

export default defineStorefront({ blocks: { "sold-by": SoldBy } });
