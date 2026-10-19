import { defineIsland } from "@scalius/plugin-sdk/island";
import type { PreviewProps } from "../storefront";

// HACK: the island reads the core buy form's private markup
// (`[data-buyer-input="<key>"]` in ProductBuyerInputs.astro). The island
// context has no buy-form API: no selected variant, no buyer input values,
// no change events (DX-REPORT CFG-3). A core markup change breaks this
// silently; the preview then just stops following the text.
export default defineIsland<PreviewProps>((element, props) => {
  const form = element.closest("form") ?? document.querySelector("form[data-product-form], form[action^='/buy/']");
  const text = element.querySelector<HTMLElement>("[data-engrave-text]");
  const plate = element.querySelector<HTMLElement>("[data-engrave-plate]");
  if (!form || !text || !plate) return;
  const input = () => form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-buyer-input="${props.inputKey}"] input, [data-buyer-input="${props.inputKey}"] textarea`);
  const font = () => form.querySelector<HTMLSelectElement>(`[data-buyer-input="${props.fontKey}"] select`);
  const draw = () => {
    const value = (input()?.value ?? "").slice(0, props.maxLetters);
    text.textContent = value.trim() === "" ? "Your text here" : value;
    plate.dataset.font = font()?.value ?? "serif";
  };
  form.addEventListener("input", draw);
  form.addEventListener("change", draw);
  draw();
  return () => {
    form.removeEventListener("input", draw);
    form.removeEventListener("change", draw);
  };
});
