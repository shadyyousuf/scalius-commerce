import { defineStorefront, type ProductMainProps } from "@scalius/plugin-sdk/storefront";

function Pdp({ data }: ProductMainProps) {
  return <h1>{data.product.title}</h1>;
}

export default defineStorefront({ skins: { pdp: Pdp } });
