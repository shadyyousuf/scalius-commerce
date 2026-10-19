import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland((element, _props, context) => {
  const wrap = element.querySelector<HTMLElement>("[data-points-wrap]");
  const value = element.querySelector<HTMLElement>("[data-points]");
  if (!wrap || !value) return;
  const controller = new AbortController();
  // HACK: the island context has no "is a buyer signed in" fact, so every
  // visitor (guests and crawlers included) costs one proxied app run.
  context.fetchApp("balance", { signal: controller.signal })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { signedIn?: boolean; points?: number } | null) => {
      if (!body?.signedIn || typeof body.points !== "number") return;
      value.textContent = new Intl.NumberFormat(context.language).format(body.points);
      wrap.hidden = false;
    })
    .catch(() => undefined);
  return () => controller.abort();
});
