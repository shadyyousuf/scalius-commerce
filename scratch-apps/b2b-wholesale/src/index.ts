// acme.wholesale: company accounts, a price list per company, minimum order
// quantities, invoice (net-30) terms and quote requests approved by staff.
// Built only from the public SDK; every hack is marked HACK and listed in
// scratch-apps/DX-REPORT.md.

import {
  adminContext,
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  wantsPage,
  type PluginContext,
  type PluginManifestInput,
  type PluginRouteRequest,
} from "@scalius/plugin-sdk";
import { membershipOf, parseMoqRules, parseQuoteForm, quoteCode, type Membership } from "./rules";

export const manifest = {
  id: "acme.wholesale",
  name: "Wholesale accounts",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Company accounts with their own price lists, minimum order quantities, invoice terms and quotes your staff approve.",
  author: { name: "Acme" },
  tagline: "B2B price lists, MOQs and quotes",
  categories: ["pricing", "checkout"],
  support: { email: "support@acme.example" },
  scopes: ["read_products", "read_customers"],
  objects: {
    companies: {
      name: "Companies",
      display: "name",
      admin: "edit",
      fields: [
        { key: "name", name: "Name", type: "single_line_text", required: true },
        { key: "terms", name: "Payment terms", type: "single_line_text", validations: { choices: ["prepaid", "net30"] } },
        { key: "credit_limit", name: "Credit limit", type: "money" },
        // HACK: a price list as JSON on the company. Core already has segment
        // price lists, but no stable operation manages them (DX-REPORT B2B-2).
        { key: "prices", name: "Prices (variant id -> minor units)", type: "json" },
        { key: "moq", name: "Minimum quantities (variant id -> units)", type: "json" },
      ],
    },
    members: {
      name: "Company buyers",
      admin: "read",
      fields: [
        { key: "company_id", name: "Company", type: "object_reference", to: "acme.wholesale.companies", required: true },
        { key: "company_name", name: "Company name", type: "single_line_text" },
        { key: "terms", name: "Terms", type: "single_line_text" },
        { key: "prices", name: "Prices", type: "json" },
        { key: "moq", name: "Minimums", type: "json" },
        { key: "approved_quotes", name: "Approved quotes", type: "json" },
      ],
      indexes: ["company_id"],
    },
    quotes: {
      name: "Quotes",
      admin: "read",
      fields: [
        { key: "customer_id", name: "Buyer", type: "customer_reference", required: true },
        { key: "company_id", name: "Company", type: "object_reference", to: "acme.wholesale.companies" },
        { key: "status", name: "Status", type: "single_line_text", validations: { choices: ["requested", "approved", "declined", "used"] } },
        { key: "lines", name: "Lines", type: "json" },
        { key: "note", name: "Buyer note", type: "multi_line_text" },
        { key: "discount", name: "Approved discount", type: "money" },
        { key: "code", name: "Code", type: "single_line_text" },
      ],
      indexes: ["status", "customer_id"],
      unique: ["code"],
    },
  },
  functions: [
    { point: "cart.line_prices", priority: 10, onError: "block", snapshot: { object: "members" } },
    { point: "cart.validate", priority: 10, onError: "block" },
    { point: "checkout.discounts", priority: 10, snapshot: { object: "members" } },
    { point: "checkout.payment_methods", priority: 10 },
    {
      point: "buyer.ui",
      targets: ["purchase.checkout.cart-line-list.render-after", "customer-account.profile.block.render"],
      snapshot: { object: "members" },
    },
  ],
  settings: [
    { key: "net_terms_tag", label: "Customer tag that allows invoice terms", type: "text", default: "net30", maxLength: 64 },
    {
      key: "invoice_method", label: "Payment method kept for invoice terms", type: "text", default: "cod", maxLength: 64,
      help: "HACK: there is no invoice/deferred payment method; the closest one is kept and every other method is hidden.",
    },
    { key: "moq_rules", label: "Minimum quantities (SKU=units, one per line)", type: "textarea", default: "", maxLength: 5000 },
  ],
  routes: {
    admin: [
      { name: "quotes", methods: ["GET", "POST"], description: "Quote requests and approvals." },
      { name: "companies", methods: ["GET", "POST"], description: "Companies and their buyers." },
    ],
    public: [{ name: "quote", methods: ["GET", "POST"], description: "The buyer's quote request page." }],
    webhooks: [],
  },
  admin: {
    pages: [
      { id: "quotes", title: "Quotes", placement: "orders", route: "quotes" },
      { id: "companies", title: "Companies", placement: "customers", route: "companies" },
    ],
  },
  storefront: { proxy: true },
} satisfies PluginManifestInput;

// HACK: `ctx.objects.<name>` is `PluginObjectCollection<Record<string, unknown>> | undefined`;
// nothing infers record types from the manifest (DX-REPORT DX-3).
const companies = (ctx: PluginContext) => ctx.objects.companies!;
const members = (ctx: PluginContext) => ctx.objects.members!;
const quotes = (ctx: PluginContext) => ctx.objects.quotes!;

function numberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && (entry[1] as number) > 0));
}

/** Copies a company's terms and price list into one buyer's membership record (the snapshot). */
async function writeMembership(ctx: PluginContext, customerId: string, companyId: string): Promise<void> {
  const company = await companies(ctx).get(companyId);
  if (!company) throw Object.assign(new Error("No such company."), { code: "wholesale.no_company" });
  const current = await members(ctx).getVersion(customerId);
  const previous = membershipOf(current?.data);
  const next: Membership = {
    company_id: companyId,
    company_name: String(company.name ?? ""),
    terms: company.terms === "net30" ? "net30" : "prepaid",
    prices: numberMap(company.prices),
    moq: numberMap(company.moq),
    approved_quotes: previous?.company_id === companyId ? previous.approved_quotes : {},
  };
  await members(ctx).put(customerId, { ...next }, { expectedRevision: current?.revision ?? null });
}

/** The proxy page HTML. HACK: proxy pages are raw HTML strings: no SDK JSX, no islands, no core embeds. */
function quotePage(message: string | null): string {
  const rows = Array.from({ length: 5 }, (_, index) => `
    <div class="aw-line">
      <label>Product variant id <input name="variant_${index}" maxlength="128"></label>
      <label>Quantity <input name="quantity_${index}" type="number" min="1" max="1000000" inputmode="numeric"></label>
    </div>`).join("");
  return `<section class="aw-quote">
    <h1>Request a quote</h1>
    ${message ? `<p role="status">${message}</p>` : ""}
    <form method="post" action="/apps/acme.wholesale/quote">
      ${rows}
      <label>Note <textarea name="note" maxlength="1000"></textarea></label>
      <button type="submit">Send request</button>
    </form>
  </section>`;
}

async function publicQuote(request: PluginRouteRequest, ctx: PluginContext) {
  const customerId = request.customer?.id ?? null;
  if (!customerId) {
    return wantsPage(request) ? { body: { redirect: "/account/login?next=/apps/acme.wholesale/quote" } } : { status: 401, body: { error: "Sign in first." } };
  }
  if (request.method === "GET") return { body: { page: { title: "Request a quote", html: quotePage(null) } } };
  const parsed = parseQuoteForm(request.body);
  if ("error" in parsed) return { status: 400, body: { page: { title: "Request a quote", html: quotePage(parsed.error) } } };
  const membership = membershipOf(await members(ctx).get(customerId));
  // A form resubmitted after a lost answer would make a second quote: the
  // proxy gives no idempotency key, so the app derives one (DX-REPORT B2B-5).
  const id = `quo_${customerId}_${Date.now().toString(36)}`;
  await quotes(ctx).put(id, {
    customer_id: customerId,
    ...(membership ? { company_id: membership.company_id } : {}),
    status: "requested",
    lines: parsed.lines,
    note: parsed.note,
  }, { expectedRevision: null });
  await ctx.messaging.notifyStaff({ title: "New quote request", body: `${parsed.lines.length} line(s)` });
  return { body: { redirect: "/apps/acme.wholesale/quote?sent=1" } };
}

async function adminQuotes(request: PluginRouteRequest, ctx: PluginContext) {
  const admin = adminContext(request);
  if (request.method === "POST") {
    const quoteId = String(admin.values.quote_id ?? "");
    const decision = String(admin.values.decision ?? "");
    const discountMinor = Math.round(Number(admin.values.discount ?? 0) * 10 ** ctx.store.decimalPlaces);
    const quote = await quotes(ctx).getVersion(quoteId);
    if (!quote || quote.data.status !== "requested") return { body: ui.result({ toast: { message: "That quote is no longer open.", tone: "critical" } }) };
    if (decision === "decline") {
      await quotes(ctx).update(quoteId, { status: "declined" }, { expectedRevision: quote.revision });
      return { body: ui.result({ toast: "Declined", refresh: true }) };
    }
    const customerId = String(quote.data.customer_id);
    const member = await members(ctx).getVersion(customerId);
    const membership = membershipOf(member?.data);
    if (!member || !membership) return { body: ui.result({ toast: { message: "The buyer is not in a company yet.", tone: "critical" } }) };
    const code = quoteCode(quoteId);
    // HACK: the approved quote reaches checkout as an order-level discount the
    // buyer applies with a code. Staff orders take no unit prices
    // (dashboard.orders.create has none), so the negotiated price cannot be
    // put on the lines themselves (DX-REPORT B2B-4).
    await ctx.objects.batch([
      { op: "put", object: "quotes", id: quoteId, record: { ...quote.data, status: "approved", discount: discountMinor / 10 ** ctx.store.decimalPlaces, code }, expectedRevision: quote.revision },
      { op: "put", object: "members", id: customerId, record: { ...membership, approved_quotes: { ...membership.approved_quotes, [code]: discountMinor } }, expectedRevision: member.revision },
    ]);
    return { body: ui.result({ toast: `Approved: the buyer uses ${code} at checkout`, refresh: true }) };
  }
  const open = await quotes(ctx).query({ where: { status: "requested" }, limit: 50, cursor: admin.cursor });
  return {
    body: ui.page([
      ui.table({
        columns: [{ key: "quote", label: "Quote" }, { key: "buyer", label: "Buyer" }, { key: "lines", label: "Lines", align: "end" }],
        rows: open.records.map((record) => ({
          id: record.id,
          cells: {
            quote: record.id,
            buyer: { text: String(record.data.customer_id), to: ui.to.resource("customer", String(record.data.customer_id)) },
            lines: Array.isArray(record.data.lines) ? record.data.lines.length : 0,
          },
        })),
        pagination: { next: open.nextCursor },
        empty: { title: "No open quote requests" },
      }),
      ui.form({ route: "quotes" }, "Save decision", [
        ui.textField("quote_id", "Quote", { required: true }),
        ui.select("decision", "Decision", [{ value: "approve", label: "Approve" }, { value: "decline", label: "Decline" }], { value: "approve" }),
        ui.numberField("discount", "Discount on the order", { min: 0 }),
      ]),
    ], { title: "Quotes" }),
  };
}

async function adminCompanies(request: PluginRouteRequest, ctx: PluginContext) {
  const admin = adminContext(request);
  if (request.method === "POST") {
    const customerId = String(admin.values.customer_id ?? "").trim();
    const companyId = String(admin.values.company_id ?? "").trim();
    if (admin.values.sync === true) {
      // Fan a changed price list out to every buyer of the company: one write
      // per buyer, because each buyer's snapshot is its own record.
      let cursor: string | null = null;
      let synced = 0;
      do {
        const page = await members(ctx).query({ where: { company_id: companyId }, limit: 100, cursor });
        for (const record of page.records) { await writeMembership(ctx, record.id, companyId); synced += 1; }
        cursor = page.nextCursor;
      } while (cursor);
      return { body: ui.result({ toast: `Updated ${synced} buyer(s)` }) };
    }
    await writeMembership(ctx, customerId, companyId);
    return { body: ui.result({ toast: "Buyer added to the company", refresh: true }) };
  }
  const page = await companies(ctx).query({ limit: 50, cursor: admin.cursor });
  return {
    body: ui.page([
      ui.table({
        columns: [{ key: "name", label: "Company" }, { key: "terms", label: "Terms" }, { key: "buyers", label: "Buyers", align: "end" }],
        rows: await Promise.all(page.records.map(async (record) => ({
          id: record.id,
          cells: { name: String(record.data.name), terms: String(record.data.terms ?? "prepaid"), buyers: await members(ctx).count({ company_id: record.id }) },
        }))),
        pagination: { next: page.nextCursor },
        empty: { title: "No companies yet", text: "Add one under Content → Objects → Companies." },
      }),
      ui.form({ route: "companies" }, "Add buyer", [
        ui.textField("customer_id", "Customer id", { required: true, help: "HACK: no customer picker in app forms (DX-REPORT B2B-6)." }),
        ui.textField("company_id", "Company record id", { required: true }),
        ui.checkbox("sync", "Re-copy the company's prices to all its buyers instead"),
      ]),
    ], { title: "Companies" }),
  };
}

export default definePlugin({
  manifest,
  functions: {
    "cart.line_prices": ({ cart, lines, snapshot }) => {
      const membership = membershipOf(snapshot?.data);
      if (!cart.customer || !membership) return { prices: [] };
      const sources = new Map(lines.map((line) => [line.lineId, line.source]));
      return {
        prices: cart.lines.flatMap((line) => {
          const price = membership.prices[line.variantId];
          // Sale, segment and market lists win over an app price; only fx/base lines take one.
          const source = sources.get(line.lineId);
          return price && (source === "base" || source === "fx") ? [{ lineId: line.lineId, unitPriceMinor: price }] : [];
        }),
      };
    },
    "cart.validate": ({ cart }, settings) => {
      const rules = parseMoqRules(String(settings.moq_rules ?? ""));
      const errors = cart.lines.flatMap((line) => {
        const minimum = line.sku ? rules.get(line.sku.toLowerCase()) : undefined;
        return minimum && line.quantity < minimum
          ? [{ code: "moq", lineId: line.lineId, message: `Order at least ${minimum} of ${line.title.slice(0, 120)}.` }]
          : [];
      });
      return { errors: errors.slice(0, 20) };
    },
    "checkout.discounts": ({ cart, snapshot }) => {
      const membership = membershipOf(snapshot?.data);
      if (!cart.customer || !membership) return { discounts: [] };
      const code = cart.discountCodes.map((value) => value.trim().toUpperCase()).find((value) => membership.approved_quotes[value]);
      if (!code) return { discounts: [] };
      const amountMinor = Math.min(membership.approved_quotes[code]!, cart.subtotalMinor);
      if (amountMinor <= 0) return { discounts: [] };
      const { [code]: _used, ...rest } = membership.approved_quotes;
      return {
        discounts: [{ title: `Quote ${code}`, code, target: { kind: "order" as const }, value: { type: "fixed_amount" as const, amountMinor } }],
        // Atomic with the order: the quote is spent exactly once.
        commit: { record: { ...membership, approved_quotes: rest } },
      };
    },
    "checkout.payment_methods": ({ cart, methods }, settings) => {
      const tag = String(settings.net_terms_tag ?? "net30");
      const keep = String(settings.invoice_method ?? "cod");
      // No snapshot here, so terms come from a customer tag the merchant keeps
      // in step with the company record by hand (DX-REPORT B2B-3).
      if (!cart.customer?.tags.includes(tag)) return { operations: [] };
      return { operations: methods.filter((method) => method.methodId !== keep).map((method) => ({ op: "hide" as const, methodId: method.methodId })) };
    },
    "buyer.ui": ({ target, snapshot, customer }) => {
      const membership = membershipOf(snapshot?.data);
      if (!customer || !membership) return { ui: null };
      if (target === "customer-account.profile.block.render") {
        return { ui: { type: "stack", children: [
          { type: "heading", text: membership.company_name || "Your company" },
          { type: "key-value", items: [{ label: "Payment terms", value: membership.terms === "net30" ? "Invoice, 30 days" : "Pay at checkout" }] },
          { type: "link", text: "Request a quote", path: "/apps/acme.wholesale/quote" },
        ] } };
      }
      return { ui: { type: "banner", tone: "info", title: "Wholesale prices", text: `Prices for ${membership.company_name || "your company"} are applied.` } };
    },
  },
  routes: {
    admin: { quotes: adminQuotes, companies: adminCompanies },
    public: { quote: publicQuote },
  },
});
