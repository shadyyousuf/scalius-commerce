// acme.rewards: points and referrals, with the balance in the header, the
// cart drawer and the account. Public SDK only; hacks are marked.
//
// What works: earning (order.paid), redeeming (checkout.discounts with an
// atomic snapshot commit), referral discounts, account and checkout Buyer UI,
// a balance island fed by a proxied public route.
// What does not: the header and the cart drawer. Only the active theme's
// header skin draws the header and nothing draws inside the cart drawer, so
// a loyalty app has no slot there (DX-REPORT LOY-1). The app ships a
// `points-badge` section a merchant can put at the top of pages instead.

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.rewards",
  name: "Rewards & referrals",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Buyers earn points on paid orders, spend them at checkout, and earn more by referring friends.",
  author: { name: "Acme" },
  categories: ["loyalty", "marketing"],
  support: { email: "support@acme.example" },
  scopes: ["read_orders"],
  events: ["order.paid"],
  objects: {
    balances: {
      name: "Balances",
      admin: "read",
      fields: [
        { key: "points", name: "Points", type: "integer" },
        { key: "earned", name: "Earned", type: "integer" },
        { key: "spent", name: "Spent", type: "integer" },
        { key: "referral_code", name: "Referral code", type: "single_line_text" },
      ],
      // A unique constraint does not serve queries: the field needs an index slot too.
      indexes: ["referral_code"],
      unique: ["referral_code"],
    },
    ledger: {
      name: "Ledger",
      admin: "read",
      fields: [
        { key: "customer_id", name: "Customer", type: "customer_reference", required: true },
        { key: "order_id", name: "Order", type: "order_reference" },
        { key: "points", name: "Points", type: "integer", required: true },
        { key: "reason", name: "Reason", type: "single_line_text", validations: { choices: ["order", "referral"] } },
      ],
      indexes: ["customer_id"],
    },
  },
  functions: [
    { point: "checkout.discounts", priority: 200, snapshot: { object: "balances" } },
    {
      point: "buyer.ui",
      targets: ["purchase.checkout.actions.render-before", "purchase.thank-you.customer-information.render-after", "customer-account.profile.block.render"],
      snapshot: { object: "balances" },
    },
  ],
  settings: [
    { key: "redeem_code", label: "Redeem code", type: "text", default: "POINTS", maxLength: 32 },
    { key: "points_per_100", label: "Points per 100 spent", type: "number", integer: true, min: 0, max: 1000, default: 5 },
    { key: "point_value", label: "Value of one point", type: "number", min: 0.01, max: 1000, default: 1 },
    { key: "referral_percent", label: "Friend's first-order discount (%)", type: "number", min: 1, max: 50, default: 10 },
    { key: "referral_points", label: "Points for the referrer", type: "number", integer: true, min: 0, max: 100000, default: 200 },
  ],
  routes: { admin: [], public: [{ name: "balance", methods: ["GET"], description: "The signed-in buyer's points, for the badge." }], webhooks: [] },
  storefront: {
    proxy: true,
    sections: [{
      type: "points-badge",
      name: "Points badge",
      description: "The signed-in buyer's points. HACK: a section, because apps cannot add to the header or cart drawer.",
      settings: [{ key: "label", label: "Label", type: "text", default: "Your points", maxLength: 40 }],
    }],
    islands: [{ name: "badge", description: "Fetches the buyer's balance after the page loads." }],
  },
} satisfies PluginManifestInput;

export interface Balance extends Record<string, unknown> { points: number; earned: number; spent: number; referral_code: string }

export function balanceOf(data: Record<string, unknown> | null | undefined, customerId: string): Balance {
  const whole = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0);
  return {
    points: whole(data?.points), earned: whole(data?.earned), spent: whole(data?.spent),
    referral_code: typeof data?.referral_code === "string" ? data.referral_code : referralCodeFor(customerId),
  };
}

/** A buyer's code: deterministic, so a function can recognise it without I/O. */
export function referralCodeFor(customerId: string): string {
  return `REF-${customerId.replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase()}`;
}

const minorPerPoint = (settings: Record<string, unknown>, decimals: number) => Math.max(1, Math.round(Number(settings.point_value ?? 1) * 10 ** decimals));

async function credit(ctx: PluginContext, customerId: string, entryId: string, points: number, orderId: string, reason: "order" | "referral"): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await ctx.objects.ledger!.get(entryId)) return;
    const current = await ctx.objects.balances!.getVersion(customerId);
    const balance = balanceOf(current?.data, customerId);
    try {
      await ctx.objects.batch([
        { op: "put", object: "ledger", id: entryId, expectedRevision: null, record: { customer_id: customerId, order_id: orderId, points, reason } },
        { op: "put", object: "balances", id: customerId, expectedRevision: current?.revision ?? null, record: { ...balance, points: balance.points + points, earned: balance.earned + points } },
      ]);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "object.conflict") throw error;
    }
  }
  throw new Error("Concurrent changes; the event will be retried.");
}

interface PaidOrder { customerRecord: { id: string; kind: string } | null; totalAmountMinor: number; discounts: Array<{ code?: string | null }> }

export default definePlugin({
  manifest,
  events: {
    "order.paid": async (event, ctx) => {
      const order = await ctx.api.call<PaidOrder>("dashboard.orders.get", { path: { id: event.resource.id } });
      if (!order.ok || !order.data) { if (order.status >= 500) throw new Error("retry"); return; }
      const buyer = order.data.customerRecord;
      if (buyer?.kind !== "account") return;
      const per100 = Number(ctx.settings.points_per_100 ?? 5);
      const points = Math.floor((order.data.totalAmountMinor * per100) / (100 * 10 ** ctx.store.decimalPlaces));
      if (points > 0) await credit(ctx, buyer.id, `earn:${event.resource.id}`, points, event.resource.id, "order");
      // The referrer: found by the code's unique index.
      const code = order.data.discounts.map((discount) => discount.code ?? "").find((value) => value.startsWith("REF-"));
      if (!code) return;
      const owner = await ctx.objects.balances!.query({ where: { referral_code: code }, limit: 1 });
      const referrer = owner.records[0];
      if (referrer && referrer.id !== buyer.id) {
        await credit(ctx, referrer.id, `ref:${event.resource.id}`, Number(ctx.settings.referral_points ?? 200), event.resource.id, "referral");
      }
    },
  },
  functions: {
    "checkout.discounts": ({ cart, snapshot }, settings) => {
      const codes = cart.discountCodes.map((value) => value.trim().toUpperCase());
      const redeem = String(settings.redeem_code ?? "POINTS").toUpperCase();
      const referral = codes.find((value) => value.startsWith("REF-"));
      // A referral code works on a signed-in buyer's first order and never on their own code.
      if (referral && cart.customer && cart.customer.orderCount === 0 && referral !== referralCodeFor(cart.customer.id)) {
        // HACK: whether REF-XXXX belongs to a real buyer is unknowable here
        // (no I/O, one snapshot of the buyer's own record), so any well-formed
        // code gets the discount; only the referrer credit checks it later.
        return { discounts: [{ title: "Referral discount", code: referral, target: { kind: "order" as const }, value: { type: "percentage" as const, percent: Number(settings.referral_percent ?? 10) } }] };
      }
      if (!cart.customer || !snapshot || !codes.includes(redeem)) return { discounts: [] };
      const balance = balanceOf(snapshot.data, cart.customer.id);
      const value = minorPerPoint(settings, cart.decimalPlaces);
      const spend = Math.min(balance.points, Math.floor(cart.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0) / value));
      if (spend <= 0) return { discounts: [] };
      return {
        discounts: [{ title: `Points (${spend})`, code: redeem, target: { kind: "order" as const }, value: { type: "fixed_amount" as const, amountMinor: spend * value } }],
        commit: { record: { ...balance, points: balance.points - spend, spent: balance.spent + spend } },
      };
    },
    "buyer.ui": ({ target, snapshot, customer }, settings) => {
      if (!customer) return { ui: null };
      const balance = balanceOf(snapshot?.data, customer.id);
      const points = { type: "key-value" as const, items: [{ label: "Points", value: String(balance.points) }] };
      if (target === "customer-account.profile.block.render") {
        return { ui: { type: "stack", children: [points, { type: "text", text: `Share ${balance.referral_code}: friends save on their first order and you earn points.` }] } };
      }
      if (target === "purchase.checkout.actions.render-before" && balance.points > 0) {
        return { ui: { type: "stack", children: [points, { type: "button", label: "Use my points", action: { kind: "apply_code", code: String(settings.redeem_code ?? "POINTS") } }] } };
      }
      return { ui: target === "purchase.thank-you.customer-information.render-after" ? { type: "text", text: "Points for this order arrive once it is paid." } : null };
    },
  },
  routes: {
    public: {
      balance: async (request, ctx) => {
        const customerId = request.customer?.id;
        if (!customerId) return { body: { signedIn: false } };
        const balance = balanceOf(await ctx.objects.balances!.get(customerId), customerId);
        // Per-buyer data: never cacheable, one Worker run per badge per page view (DX-REPORT LOY-2).
        return { body: { signedIn: true, points: balance.points } };
      },
    },
  },
});
