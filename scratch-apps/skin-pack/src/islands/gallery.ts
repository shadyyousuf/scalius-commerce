import { defineIsland } from "@scalius/plugin-sdk/island";

// HACK: there is no "variant changed" event or buy-form state in the island
// context. The buy form keeps the chosen SKU in a hidden input
// (ProductBuyerInputs.astro: `input[name=variant]`), private markup that
// may change without notice (DX-REPORT CFG-3).
export default defineIsland<{ variants: Array<{ id: string; image: string | null }> }>((element, props) => {
  const form = document.querySelector<HTMLFormElement>("form[action^='/buy/']");
  const stack = element.querySelector<HTMLElement>(".atelier-stack");
  if (!form || !stack) return;
  const show = () => {
    const chosen = form.querySelector<HTMLInputElement>("input[name=variant]")?.value;
    const url = props.variants.find((variant) => variant.id === chosen)?.image;
    if (!url) return;
    const match = [...stack.querySelectorAll("img")].find((image) => image.currentSrc.startsWith(url) || image.src.startsWith(url));
    if (match && stack.firstElementChild !== match) stack.prepend(match);
  };
  form.addEventListener("change", show);
  return () => form.removeEventListener("change", show);
});
