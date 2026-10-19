import { defineStorefront, Island, type BlockProps } from "@scalius/plugin-sdk/storefront";

export interface PreviewProps { inputKey: string; fontKey: string; maxLetters: number }

function Preview({ data, settings }: BlockProps<{ plate: string; label: string }>) {
  if (data.product.fields["acme.engraving.engravable"] !== true) return null;
  const max = Number(data.product.fields["acme.engraving.max_letters"] ?? 24);
  return (
    <figure class="acme-engrave">
      <figcaption>{settings.label}</figcaption>
      <Island name="preview" props={{ inputKey: "engraving", fontKey: "font", maxLetters: Number.isFinite(max) ? max : 24 } satisfies PreviewProps} hydrate="visible">
        <div class="acme-engrave-plate" style={`--plate:${settings.plate}`} data-engrave-plate>
          <span data-engrave-text>Your text here</span>
        </div>
      </Island>
    </figure>
  );
}

export default defineStorefront({ blocks: { preview: Preview } });
