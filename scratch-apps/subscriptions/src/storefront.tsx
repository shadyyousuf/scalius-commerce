import { defineStorefront, Price, type BlockProps } from "@scalius/plugin-sdk/storefront";

// HACK: the block cannot tell whether this product offers the `subscribe`
// buyer input: StorefrontProductPage carries no buyer inputs, so the merchant
// must mark subscribable products with a storefront-visible custom field too.
function SubscribeNote({ settings, data, context }: BlockProps<{ text: string }>) {
  const offered = data.product.fields["acme.subscribe.offered"] === true;
  if (!offered) return null;
  return (
    <aside class="acme-sub-note">
      <p>{settings.text}</p>
      <p class="acme-sub-from">From <Price price={data.product.price} context={context} /> per delivery</p>
    </aside>
  );
}

export default defineStorefront({ blocks: { "subscribe-note": SubscribeNote } });
