import { defineStorefront, Island, type SectionProps } from "@scalius/plugin-sdk/storefront";

function PointsBadge({ settings }: SectionProps<{ label: string }>) {
  // Rendered into the cached public page with no buyer data; the island fills it in.
  return (
    <aside class="acme-points" aria-live="polite">
      <Island name="badge" props={{}} hydrate="idle">
        <span hidden data-points-wrap>{settings.label}: <strong data-points>0</strong></span>
      </Island>
    </aside>
  );
}

export default defineStorefront({ sections: { "points-badge": PointsBadge } });
