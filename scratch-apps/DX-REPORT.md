# Scalius extension platform: third-party DX report (2026-10-19)

I evaluated the extension platform as an outside developer. Base: `claude/commerce-hooks-plugins-builder` at `89b710b07`. I used only the public SDK (`@scalius/plugin-sdk`, `/testing`, `/fixtures`, `/storefront`, `/storefront/testing`, `/island`), `packages/api-client` and the repo's tooling (`pnpm plugin create | validate | pack | keygen | preview`). I changed no core code. Every app below typechecks, passes its tests in the SDK harness and packs. The B2B app is also signed.

```sh
bash scratch-apps/check.sh   # from the repo root: typecheck 8 projects, 40 tests, validate + pack 7 apps
```

| # | App (`scratch-apps/`) | id | What runs | Verdict |
| --- | --- | --- | --- | --- |
| 1 | `b2b-wholesale` | `acme.wholesale` | 5 functions, quote proxy page, 2 admin pages, Objects | Works only with hacks; net-30 and 100+ unit MOQs are blocked |
| 2 | `subscriptions` | `acme.subscribe` | event capture, hourly renewals by cron, account Buyer UI skip/cancel, product block | The demo works; production is blocked by payment |
| 3 | `marketplace` | `acme.market` | order split, vendor proxy dashboard with partial fulfilment, payout report | Usable for small catalogues; there is no vendor principal |
| 4 | `engraving` | `acme.engraving` | `cart.validate` (block), per-letter `cart.line_prices`, preview block + island | Works, but the preview scrapes core DOM and add-ons are lost on sale items |
| 5 | `loyalty-referrals` | `acme.rewards` | earn/redeem with atomic commit, referrals, account/checkout UI, balance island | Points are not in the header or cart drawer: no slot |
| 6 | `skin-pack` | `acme.atelier` | header skin with mega-menu, card, product-main with its own gallery, lookbook section, template | Good; no cart-drawer upsell, and promo art is static |
| 7 | `headless-next` | n/a | typed data layer on `@scalius/api-client`, Next page and server action (code only) | Works inside the fork only; the client is private |
| 8 | `erp-sync` | `acme.erp` | HMAC webhook inbox, durable per-SKU queue, idempotent apply, order export | Correct, but about 167 minutes or more per 10k SKUs |

`probes/` holds two deliberately broken apps. Each passes a gate it should fail (DX-4).

Most of `audit/V2-LOCK-AUDIT-2026-10-19.md` is already fixed on this branch: the theme upgrade chain, skin projections, the protected-data tier, `read_inventory`, sealed webhook representations, port tiers, the canonical grant key and the plugin licence exception. I re-report a known item only where building showed it is worse than described. Those are marked "(known #n, worse)".

---

## Lock-blockers: wrong shape, painful to change after the lock

### LB-1. Stable operations have four idempotency contracts, and the SDK documents a fifth

- **Evidence.**
  - `ctx.api.call` documents "a mutating call needs `idempotencyKey` (8-200 characters)" (`packages/plugin-sdk/README.md`, `ctx`; `apps/api/src/plugins/api-call.ts:64-66`).
  - The sealed operations disagree (`apps/api/src/openapi/stable-operations.snapshot.json`):
    - `dashboard.inventory.set_stock` takes an `Idempotency-Key` header of 16-128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$`, *and* a body `operationKey` that must match it.
    - `dashboard.orders.create` and `dashboard.orders.fulfillment_create` need the header *and* a body `requestKey` that must be a UUID.
    - `dashboard.product_variants.update` and `dashboard.orders.update_status` are `idempotency: none`, and passing a key is an error (`apps/api/src/agent-access/dispatch.ts:269-280`, `idempotency_not_supported`).
  - `update_status` also has `revision: none`, so a status write is neither idempotent nor conditional.
  - My apps needed three helpers: a padded key for stock (`erp-sync/src/index.ts`), a SHA-256-derived UUID for orders and fulfilments (`subscriptions/src/index.ts` `renewalKey`, `marketplace/src/index.ts` `uuidFrom`), and *no* key for variant updates. My first draft used `crypto.randomUUID()` for `requestKey`, which silently defeats retry safety.
- **Why it is a lock-blocker.** `requestKey` and `operationKey` are required fields in sealed request schemas. Removing them, or relaxing the UUID format, is not additive.
- **Proposed contract.**
  - Accept exactly one key on every stable mutating operation: `Idempotency-Key`, 8-200 opaque printable characters, stored with the request hash.
  - Drop `requestKey` and `operationKey` from the stable schemas, or keep them only as optional aliases with no format rule.
  - Operations without a natural replay store still accept the key and replay the first response for 24 hours.
  - Every stable write that is not a create declares `revision: required` or `optional`, never `none`.

### LB-2. The function snapshot is a one-record, one-type, customer-keyed shape, and it is becoming the de-facto "reads" mechanism (known #11, worse)

- **Evidence.**
  - `snapshot: { object }` exists only on `cart.line_prices`, `checkout.discounts` and `buyer.ui` (`packages/shared/src/plugins/manifest.ts:108-109`).
  - It is always the signed-in buyer's record with `id = customerId` (`packages/shared/src/plugins/functions.ts:99`). `cart.validate`, `checkout.payment_methods` and `checkout.shipping_rates` get none.
- **What this forced in my apps.**
  - B2B: a company's price list, MOQs and approved quotes are copied into every buyer's `members` record. A company of 40 buyers stores 40 price lists, and a re-price fans out one write per buyer (`b2b-wholesale/src/index.ts` `adminCompanies` sync). The 64 KiB record cap bounds a list to about 1,500 SKUs.
  - Subscriptions: every subscription is mirrored into a `portals` record per buyer so the account block can list them.
  - MOQs: `cart.validate` reads a store-wide `SKU=units` textarea setting, because no per-company or per-product data reaches it (`b2b-wholesale/src/rules.ts` `parseMoqRules`).
  - Net terms: `checkout.payment_methods` decides from a customer tag that staff must keep in step with the company record by hand.
- **Why it is a lock-blocker.** `input.snapshot` and `commit.record` become sealed function ABI. A later general `reads` would sit beside them forever, as two mechanisms for one job.
- **Proposed contract.** Before sealing, replace `snapshot` with declared reads shared by every point:

  ```ts
  functions: [{ point: "cart.validate", reads: [
    { as: "member",  object: "members",   key: "customer" },                 // record id = customer id
    { as: "company", object: "companies", key: { from: "member.company_id" } }, // one hop, bounded
    { as: "moq",     object: "moq",       key: "line.variantId", max: 100 },     // one record per cart line
    { as: "fields",  customFields: ["product:min_qty"] },                        // the app's own fields on line products
  ] }]
  // input.reads.member: { revision, data } | null; input.reads.moq: Record<variantId, { revision, data }>
  // checkout.discounts may answer commit: [{ as: "member", record }]  (CAS at the read revision, in the order batch)
  ```

  - Keys are `customer`, `line.variantId`, `line.productId`, a checkout attribute, or one bounded hop.
  - The host reads them in the existing checkout batch wave, bounded to 4 reads, 100 records and 256 KiB.
  - `snapshot` becomes sugar for `reads: [{ as: "snapshot", object, key: "customer" }]`, or is removed before the seal.

### LB-3. Manifest vocabulary is inconsistent in sealed JSON Schema shapes

- **Evidence**, each one a failed first run of mine:
  - Product block placement is `"buy-box" | "below"` in the manifest (`manifest.ts:270`), but the render target, the testing helper and the docs say `product.buy-box` / `product.below` (`storefront-protocol.ts:27`; `docs/STOREFRONT-COMPONENTS.md`, "draw as block jobs at `product.buy-box`").
  - Admin and public routes are `{ name, methods }` objects; webhook routes are bare strings (`manifest.ts:519`).
  - Identifier styles differ. Route names, timeline kinds, page ids and skin ids are kebab (`PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/`, `manifest-patterns.ts:6`). Object types, field keys, setting keys and custom field keys are snake (`objects.ts`, `OBJECT_TYPE_PATTERN`). I wrote `vendor_split` as a timeline kind and was refused.
  - An object index is a string for one field and an array of at least 2 for several (`objects.ts` `indexSchema`). `["order_id"]` is refused.
  - A `unique` constraint does not serve queries; the same field needs an index slot too, out of only four (`loyalty-referrals`: `object.unindexed_query`).
- **Why it is a lock-blocker.** All of these are in `abi.snapshot` (the manifest JSON Schema). Every fix after the lock is a breaking change or a permanent alias.
- **Proposed contract.**
  - Use one placement name everywhere (`product.buy-box`).
  - Make every route `{ name, methods?, description? }`, webhooks included (default `["POST"]`).
  - Use one identifier pattern for every manifest name: `^[a-z][a-z0-9_]{0,47}$`, snake, since object and field keys are data keys. Accept kebab only where a URL needs it, and derive the path.
  - Accept `string | string[]` (length at least 1) for indexes.
  - Let `unique` imply a queryable index.

### LB-4. There are two declarative UI trees, plus raw HTML for proxy pages

- **Evidence.**
  - Admin UI is `PluginUiNode` (`packages/shared/src/plugins/ui.ts:164-190`: `page`, `card`, `table`, `form`, `text-field`, …, buttons that call admin routes).
  - Buyer UI is a separate `BuyerUiNode` (`buyer-ui.ts:28-37`). The same names mean different things: `key-value` values are strings here but `string|number|boolean|null` there, and buttons carry `action.kind` here but `action.route` there.
  - Proxy pages take an HTML string (`storefront.ts` `pluginPageOutputSchema`) with no SDK component and no escaping guidance.
  - My vendor dashboard interpolated vendor names unescaped until I found that `escapeHtml` from `/storefront` also works in a route (SEC-3).
- **Why it is a lock-blocker.** Both trees are sealed ABI. Merging them later breaks every app that emits either.
- **Proposed contract.** Use one `ui` tree (`version: 1`) with a per-surface allowlist (`admin`, `buyer`, `proxy`):
  - one node vocabulary and one action union: `{ kind: "route", surface, route, body }` and `{ kind: "cart", op: "add_line" | "apply_code" | "set_attribute" }`;
  - one SDK builder (`ui.*`) for all three surfaces;
  - proxy pages answer the same tree, so the host renders them (themes, i18n, no-JS forms) instead of trusting app HTML.

### LB-5. Money has two units inside one app (known #5, worse: it reaches Objects)

- **Evidence.**
  - Functions, `ui.table` money cells (`{ money: minor }`, `ui.ts:131`) and webhook representations use integer minor units.
  - An Object `money` field reads and writes decimal major units through the SDK: "Money is stored in minor units; HTTP/SDK values use the shared codec's wire units" (`objects.ts:160`).
  - Storefront `fields` carry "money in major units" (`storefront-protocol.ts:293`).
  - My B2B quote stores `discount` as a decimal major `money` field and the same amount in minor units in the member snapshot (`b2b-wholesale/src/index.ts` `adminQuotes`). The marketplace avoids `money` entirely and uses `integer` `*_minor` fields.
- **Proposed contract.** Before the seal, `money` crosses every app boundary (objects, custom fields, storefront fields, function inputs, admin UI) as `{ amountMinor: number, currency: string }` (or a bare minor integer plus a declared currency). Decimal major units stay a rendering concern.

---

## Fix before the beta label

### Developer experience

- **DX-1. An app can only be built inside a clone of the fork.**
  - What happens:
    - `pnpm plugin create acme.wholesale --dir scratch-apps/b2b-wholesale` succeeds and says "Run pnpm install". The app then cannot resolve `@scalius/plugin-sdk`: "✗ Bundles: Could not resolve "@scalius/plugin-sdk"".
    - The scaffold writes `workspace:*` dependencies and `paths: { "@scalius/shared/*": ["../../packages/shared/src/*"] }` (`scripts/plugin-scaffold.mjs:20-31`), so the app only resolves at depth 2 inside a workspace glob.
    - The packer bundles from the repo root (`scripts/plugin-build.mjs:150`).
    - `@scalius/api-client` is `private: true` (`packages/api-client/package.json`).
    - I worked around all of this with `scratch-apps/tsconfig.base.json` and `scratch-apps/vitest.config.ts` aliases.
  - Fix:
    - Publish `@scalius/plugin-sdk` and a `scalius` CLI (`scalius app create | dev | validate | pack | sign`) that run from any directory against the published SDK.
    - Have the scaffold depend on `@scalius/plugin-sdk@^x`, not on workspace paths.
    - `create --dir` should refuse a directory outside `pnpm-workspace.yaml` until then.
- **DX-2. The test harness is less strict than the platform.** Tests pass, then production drops or refuses the call.
  - Gaps, each with evidence:
    - `harness.fn(point: string, input: unknown)` validates neither side (`packages/plugin-sdk/src/testing.ts:335`). `b2b-wholesale/src/index.test.ts` shows an invalid input and an output with `unitPriceMinor: 0.5` reported as `ok: true`; checkout skips it, or blocks with `onError: "block"`.
    - The `api` mock is not contract-aware. My ERP app called `dashboard.products.get_section` with `section: "core"`; the contract enum is `base|text|media|…` (`erp-sync/src/index.ts`). Idempotency rules (LB-1) are not simulated either.
    - `messagingEmail` and `messagingSms` skip the `read_customers` check that the host enforces (`testing.ts:274` vs `apps/api/src/plugins/messaging.ts:29-33`); `marketplace/src/index.test.ts` proves it.
  - Fix:
    - Make `fn<P extends PluginFunctionPoint>(point, input: PluginFunctionInput<P>)` typed, parsing both sides with `PLUGIN_FUNCTION_SCHEMAS` and returning the platform's `function.invalid_output`.
    - Add `createContractApi({ handlers })`, which validates every `ctx.api.call` against `stable-operations.snapshot.json`: path enums, required body, idempotency and revision.
    - Run the host's scope checks in the harness bridge.
- **DX-3. Nothing infers types from the manifest.**
  - `ctx.objects` is `Record<string, PluginObjectCollection<Record<string, unknown>>>` (`packages/plugin-sdk/src/context.ts`), so every app writes `ctx.objects.x!` and casts records.
  - Settings are `PluginSettingValue`.
  - `SectionProps<{ heading: string; … }>` repeats the manifest's settings by hand (`skin-pack/src/storefront.tsx`).
  - Fix: make `definePlugin` infer `ctx.objects.<name>: Collection<RecordOf<fields>>` and `ctx.settings` types, and add `defineStorefront<typeof manifest>()` so `sections[type]` gets typed settings. This is additive.
- **DX-4. `pnpm plugin validate` says "ready to pack" for apps that cannot pack or install.**
  - It never checks the storefront module: `scripts/plugin-validate.mjs` has no storefront check. `probes/broken-skin`, a `product-main` skin without `<BuyForm/>`, passes validate and fails pack.
  - A custom field `type` is a free string "checked at install" (`manifest.ts:155-156`). `probes/bad-field` declares `type: "colour_hex"`, then packs and signs.
  - Fix: validate runs `packStorefront`'s compile and smoke render, and `customFieldSchema.type` becomes `z.enum(CUSTOM_FIELD_TYPES)`.
- **DX-5. Small papercuts.**
  - `keygen <dir>` writes `<dir>/signing-key.pem`, but `--key <dir>` fails with "Cannot read the signing key <dir>. Make one with: pnpm plugin keygen <folder>". Accept the folder.
  - `pnpm plugin preview` renders an empty page when a block depends on custom fields, and gives no "rendered nothing" note and no way to pass fixture fields. I saw this with engraving's preview; add `preview --fixture <json>`.
  - The manifest TypeScript error for a wrong `placement` is a 15-line structural wall. A branded `defineManifest()` would point at the key.

### Commerce contract

- **B2B-7. A cart line cannot exceed 99 units.**
  - `apps/api/src/routes/storefront-orders/checkout.ts:281` and `cart-validation.ts:105` cap it (`.max(99)`). The sealed `dashboard.orders.create` has `quantity ≤ 99` and `items ≤ 99`.
  - A wholesale MOQ of 120 is unbuyable whatever `cart.validate` answers.
  - Fix: a `planLimits()` or store setting (default 99, ceiling 1,000,000), the same in every schema. Raising an input maximum is additive, so do it now while nobody depends on the error.
- **B2B-2 / SUB-2. Staff orders (`dashboard.orders.create`) cannot express what apps need to place.**
  - The operation has no `customerId`: an app copies name, phone and address, and must hold all four PII scopes (`subscriptions` manifest).
  - It has no unit price per line (quote → order impossible) and no payment method or terms. Staff orders are always `cod` (`packages/core/src/modules/checkout/manual-order-apps.ts:72`).
  - It has no `attributes` and no `channel: "app"`.
  - It requires `customerPhone` (min 7) and seals the BD `city`/`zone`/`area` fields (known #6).
  - Fix (additive while unsealed; better before beta): add optional `customerId`, `items[].unitPriceMinor` (staff/app override, audited), `paymentMethod`, `paymentTerms: { kind: "net", days }`, `attributes` and `channel: "app"` (default when the principal is an app).
- **B2B-3 / SUB-3. No deferred payment flow.**
  - `flow: z.enum(["hosted"])` (`packages/shared/src/plugins/providers/descriptors.ts:81`), and core offers COD plus gateways only (`packages/core/src/modules/checkout/config.ts:186-211`).
  - Net-30 is impossible. My B2B app hides every method except a configurable one ("cod" by default), so a net-30 order outside Bangladesh has no method at all.
  - Fix: a `deferred` payment flow (a method with `dueInDays`; the order commits with `paymentStatus: "pending"` and a due date, and is paid later through `payment.updated`). Built-in "Invoice / net terms", gated by a function or customer tag. Adding the enum value is additive, but B2B and subscriptions both depend on it (known #20 covers authorise/capture and off-session charges).
- **B2B-2b. Segment price lists exist but are unreachable and invisible.**
  - Core already prices segments (`packages/core/src/modules/price-lists/README.md`: "segment lists … apply only to a signed-in member, never to a public read").
  - No stable operation manages them (known #6), so I re-implemented price lists in Objects.
  - Even core's own segment price shows only at checkout, never on the product page or cards.
  - Fix: stable `price_lists.*` operations, plus a private "buyer prices" read (`POST /api/v1/storefront/buyer-prices { variantIds }`, signed-in, uncached) that themes and islands call to restate prices for B2B buyers.
- **CFG-1 / CFG-3. Configurators cannot see or follow the buy form.**
  - The `product-main` and block projection carries no buyer inputs (`storefront-protocol.ts:309-341`), although the public product API does (`customization`, `GetApiV1ProductsBySlugResponses`).
  - The island context has `onCart` only (`storefront-protocol.ts:721-743`): no selected variant, no input values, no change event.
  - My engraving preview and my stacked gallery read private markup (`[data-buyer-input="engraving"] input`, `input[name=variant]` from `ProductBuyerInputs.astro`).
  - Fix:
    - Add `buyerInputs` to `StorefrontProductPage` (key, type, label, maxLength, options).
    - Add `context.product` to islands on product pages: `{ state(): { variantId, quantity, inputs }, onChange(listener) }`.
- **CFG-2. A price add-on cannot be expressed.**
  - `cart.line_prices` replaces the unit price, and "only lines priced at `fx` or `base` take an app price" (`functions.ts:228`), so per-letter engraving is free on any product in a sale or price list.
  - `cart.transform` refuses lines with buyer inputs.
  - Fix: `cart.line_prices` may also answer `adjustments: [{ lineId, amountMinor, title }]`. These are add-ons applied after price precedence and shown as line components. This is additive.
- **SEC-1. Any app with `read_customers` can email or SMS any address from the store's sender.**
  - `sendPluginEmail` accepts `to` (any address) with up to 100 KB of HTML at 60 a minute (`apps/api/src/plugins/messaging.ts:95-134`). The only gate is `customers.view`.
  - That is phishing from the merchant's own domain, and nothing on the consent screen says so.
  - Fix:
    - `to` reaches only a customer id, staff, or addresses in a manifest-declared `messaging.recipients: "app_records"` capability, listed on the consent screen.
    - Arbitrary `to` gets its own `send_email_any` scope, marked sensitive.
- **SEC-3. Proxy pages invite injection.** They are sanitized (`apps/storefront/src/pages/apps/[pluginId]/[...path].astro:34`), but `forms: true` lets injected markup add forms that post to store paths. Fix: LB-4's tree, or at minimum `html` and `escapeHtml` exported from the root SDK and used in the README example.
- **LOY-1 / THM-3. Apps have no slot in the header, the cart drawer or the cart page body** (known #21, worse).
  - A loyalty app cannot show points in a header it does not skin.
  - A theme skin cannot host another app's block. The `StorefrontEmbedKind` set has no app-slot embed (`storefront-protocol.ts:48`).
  - The cart drawer is not skinnable at all.
  - Shopify solves this with app blocks inside sections plus app embeds (Sources).
  - Fix:
    - A `<Slot name="header.actions" />` embed kind that skins and core both place.
    - App `blocks` declare `targets: ["header.actions", "cart-drawer.footer", "product.buy-box", …]` and draw there.
    - Core's own header, drawer and cart page place the same slots.
    - The embed set is extensible, so this is additive, but every core unit should ship with slots before themes are written against it.
- **LOY-2. Per-buyer data on public pages costs one app run per island per page view.**
  - My balance island must call `/apps/<id>/balance` on every page, for guests and crawlers too: there is no signed-in fact in the island context.
  - Each call is an uncached proxied route run, rate-limited to 60 per minute per client.
  - Fix:
    - A buyer-fragment read: Objects declared `buyerVisible: { key: "customer" }` are returned for the signed-in buyer by one private `/api/v1/storefront/buyer` call, shared by all apps, with no app code run.
    - Add `context.buyer: { signedIn }` to islands.
- **ERP-1 / ERP-2. Bulk sync is structurally slow and racy.**
  - One stable write moves one SKU (`inventory.set_stock`), at 60 calls a minute and 50 per run on Free. 10,000 SKUs is at least 167 minutes, and about 3.5 days of Free cron.
  - No operation finds a variant by SKU (only `lookup_barcode`), so the app mirrors a SKU map from product events.
  - A price change is a full-body `PUT` of the variant (options, image, weight, SKU, `expectedAggregateRevision` all required) and loses to any concurrent editor save.
  - Shopify's `inventorySetQuantities` takes 250 items per call (Sources).
  - Fix:
    - `inventory.set_quantities { items ≤ 250 }` (one ledger batch per chunk).
    - `product_variants.lookup { skus ≤ 90 }`.
    - `product_variants.patch_prices { items ≤ 100: { variantId, priceMinor, expectedStockVersion? } }` with field-level semantics that do not churn `aggregateRevision`.
    - An app "bulk" rate class.
- **HL-1…7. Headless works inside the fork only.**
  - The api-client is private.
  - Batch parts are `body: string`, untyped (`GetApiV1StorefrontBatchResponses`).
  - There is no server cart: the client echoes decimal `price` per line and `shippingCharge`.
  - Customer sessions are SameSite=Lax cookies (`apps/api/src/routes/customer-auth/identity.ts:212`), with no bearer token for another domain or a mobile app.
  - No SDK renders `buyerUi` blocks.
  - Hosted payments return to the Astro storefront.
  - Operation names are path-derived (`getApiV1ProductsBySlug`).
  - Fix: either state "headless is beta" (known #7) or seal a small storefront surface:
    - a server cart resource (`carts.create|get|lines_*`, prices server-owned);
    - a customer token flow (OAuth PKCE, as Shopify's Customer Account API does);
    - `returnUrl` on checkout;
    - named operation ids;
    - a framework-free Buyer UI renderer in `@scalius/storefront-kit`.

---

## After the lock (additive)

- **MKT-1. External principals.** Vendors, company buyers and partners have no identity. The marketplace dashboard is a proxy page keyed by customer account, and staff RBAC cannot be scoped to "own products".
  - Primitive: `principals` of an app-declared kind (`acme.market.vendor`) with their own sign-in (customer auth reused), and route grants `routes.portal` that receive `{ principal: { kind, id } }`.
  - Medusa does this with custom actor types; Vendure does it with Seller channels.
- **MKT-2.** Split orders or per-vendor sub-orders (Vendure splits seller orders natively), per-vendor shipping rates (`checkout.shipping_rates` can only hide, rename, price or reorder), and a payouts port.
- **MKT-3. Object aggregates and range queries.** Indexes allow equality plus order only, so "due before today" (`subscriptions` cron) and "sum by vendor and period" (`marketplace` payouts) are full scans in app code.
  - Add `where: { next_at: { lte } }` on the ordered field, and `ctx.objects.x.aggregate({ where, sum: ["subtotal_minor"] })` within quotas.
- **SUB-1. Selling plans.** There is no way to put a purchase option on a line. My app relies on a merchant-configured buyer input named `subscribe`.
  - Primitive: `sellingPlans` declared by an app; a line `plan: { app, id }` priced through `cart.line_prices` adjustments.
  - Shopify's Selling Plan + Subscription Contract + Customer Payment Method APIs are the bar (Sources).
- **Off-session payments and saved methods** (known #20).
- **Buyer UI.** Actions cannot request a re-render; the page reloads (`apps/storefront/src/lib/buyer-ui/index.ts:163`). Images are only store media or app files. Add `ui.result({ refresh: true })`, as admin has.
- **Events.** `order.refunded` facts name no lines, so a partial refund cannot be charged to a vendor without re-reading the order. Add `facts.lines: [{ itemId, quantity, amountMinor }]`.
- **THM-1 / THM-2.**
  - Skin settings cannot use `image`, "a skin reads nothing" (`storefront-components.ts:50-56`). Menu items carry only `{ title, url, children }`. Together these mean a mega-menu's promo art is a file in the app package, not merchant content.
  - `list` items cannot hold products, so a lookbook look cannot name its own products.
  - Fix: bounded `image` settings on header and footer skins, resolved in the layout read (at most 8); optional `image` and `description` on menu items; `product` fields inside `list`.

---

## How the incumbents do these today

| Attempt | Shopify | Medusa v2 | Vendure | Scalius today |
| --- | --- | --- | --- | --- |
| B2B | Companies, locations, catalogs, quantity rules (min/max/increment), volume pricing, net 15/30/60 payment terms, vaulted cards; Functions for order minimums and credit limits | Custom module plus links to customer and product; pricing module price lists with customer-group rules | Customer groups, Channels per price tier, `OrderItemPriceCalculationStrategy` | Objects plus a per-buyer snapshot copy; core segment lists are unmanaged by apps; no net terms; lines stop at 99 |
| Subscriptions | Selling Plan API, Subscription Contract and Billing Cycle APIs, Customer Payment Method API | A recipe on workflows plus scheduled jobs and a payment provider | Plugins (job queue, payment strategy) | A buyer input named `subscribe`, cron, COD staff orders; no saved methods |
| Marketplace | No native multi-vendor (third-party apps) | Marketplace recipe: vendor module, links, custom actor type for vendor admins, order split (Mercur starter) | Native Sellers plus Channels, a seller order split strategy | Objects plus a proxy dashboard, no principal, no order split |
| Configurator | Line properties plus Cart Transform `lineUpdate` price override (Plus only) | Custom line-item metadata plus workflow hooks | OrderLine custom fields plus price calculation strategy (the documented engraving example) | Merchant buyer inputs plus `cart.line_prices` (base/fx lines only), DOM-scraping island |
| Loyalty in header and drawer | Theme app extension app blocks plus app embeds (drawer coverage is theme-dependent) | Headless only | Headless only | No header or drawer slot |
| Theme skins | Online Store 2.0 sections, blocks, JSON templates | n/a | n/a | Skins plus sections plus embeds; strong edge model, missing slots |
| Headless | Storefront API (public token, cart object, buyer identity), Customer Account API (OAuth PKCE), Hydrogen | Store API plus JS SDK (published) | Shop GraphQL API | A private api-client, client-side cart, cookie sessions |
| ERP | `inventorySetQuantities` (250 per call), bulk operations, webhooks | Workflows plus module services (no network limits) | Admin API plus import plugins | One SKU per call, 60 calls a minute, no SKU lookup |

---

## The architecture as a whole

**Can it be learned in a day?** The pure-function core can: functions, Objects with CAS, events with `event.id`, and admin UI trees. I had the first app packing in under an hour. The whole surface cannot:

- 37 top-level manifest keys (`manifest.ts:441-580`), plus 11 under `storefront`;
- 14 ports;
- 9 function points;
- 9 Buyer UI targets;
- 2 block placements;
- 5 skin units plus 15 core-section skin targets;
- 8 embed kinds;
- 3 route surfaces plus proxy;
- features with their own scopes and hosts;
- 3 UI dialects (LB-4).

The prose docs are excellent, among the best I have read. They compensate for a surface that is too wide, and they drift from it (LB-3, LB-1).

**Concepts that overlap and confuse:**

1. **Sections vs product blocks vs skins vs templates vs page presets vs embeds.** A product block is a section with a fixed target, a page preset is a partial template, and an embed is a core-owned slot. Merge them: **component** (renders at a `target`), **skin** (replaces a core unit), **slot** (a named place where components render, core- or skin-owned). Templates and presets become theme documents. This is known #14; I agree and would go further.
2. **Objects vs custom fields vs snapshot vs `ctx.kv` vs settings.** Custom fields are "typed attributes on core resources", which is an Object keyed by a core id. Snapshot is a read of an Object. `kv` is an Object with a TTL. Keep Objects as the one storage primitive. Treat custom fields as `objects: { x: { owner: "product" } }`, an owner-keyed object type that storefronts can see. `kv` becomes an object option `ttl`. Settings stay.
3. **Features vs apps vs packs.** Features are sub-apps with their own consent, which is right for regional packs. For everyone else it is a second module system. Keep it, but scaffold and document it as "pack-only".
4. **Functions vs ports vs events.** These are clean in principle: functions decide, ports do I/O, events observe. They blur in practice: `order.risk` is a function that runs after commit like an event; `checkout.payment_methods` is a function while the payment port has its own `countries` filter; the tax port and functions both influence totals. Rule of thumb for the docs: *a decision inside a request → function; a provider of a capability → port; a reaction after commit → event*. Move `order.risk` to an event handler that may call `ctx.orders.hold()`.

**What I would delete or merge:**

- `buyer.ui` as a function point. Make it the Buyer UI surface of the one `ui` tree, fed by the same `reads`.
- `snapshot` (folded into `reads`).
- The webhook-name-only route shape.
- The proxy page HTML path (folded into the `ui` tree).
- `productBlocks` (folded into components with `target`).
- `pagePresets` (theme documents).
- Product-level discounts (known #13).

**The smallest set of additive primitives that unblocks most of the eight attempts:**

| Primitive | Shape | Unblocks |
| --- | --- | --- |
| **P1. Declared reads** (LB-2) | `reads: [{ as, object \| customFields, key }]` on every function point, Buyer UI and component; `commit` keyed by `as` | B2B pricing, MOQ and terms; subscriptions portal; loyalty; marketplace one-vendor-per-cart; engraving limits |
| **P2. Slots** | `<Slot name>` embed placed by core units and skins; components declare `targets` | Loyalty in header and drawer; cart-drawer upsell; theme plus app composition |
| **P3. Line adjustments and line plans** | `cart.line_prices` → `adjustments[]`; lines may carry `plan: { app, id }` and app-written `properties` through a cart action `set_line_property` | Engraving add-ons, subscribe & save, B2B surcharges |
| **P4. Deferred and off-session payment** | Payment flow `deferred` (terms, due date) and `charge_saved` (mandate id), on the existing port | Net-30, subscriptions, post-purchase |
| **P5. App principals** | App-declared principal kinds with portal routes and a scoped `ctx.api` | Vendor dashboard, company buyers, partner portals |
| **P6. Bulk operations** | `*_batch` stable writes (≤250) with one `Idempotency-Key`, SKU lookup, patch semantics | ERP, PIM, price-list sync |
| **P7. Buyer fragment read** | `buyerVisible` Objects served to the signed-in buyer by one private call shared by all apps | Points badge, B2B prices on product pages, "your subscriptions" anywhere, without app runs |

P1, P2 and P3 change shapes that are about to be sealed, so do them, or at least name them, before the lock. P4 to P7 are additive.

---

## Security and performance notes (beyond the items above)

- **Sandbox.** Bundled apps (the only option on Free) run as trusted code in the API Worker. An outside vendor's app on a Free store is therefore trusted, own-forked code, the same as a WordPress plugin. The docs say so honestly. The marketplace story should still say "Free plan apps are private code you trust".
- **CPU.** A function's budget is 50 ms CPU and 1.5 s wall in the isolate. My heaviest function (B2B line prices over 250 lines with a 1,500-entry map) stays far below that. The 64 KiB snapshot cap is the binding limit, not CPU.
- **D1.** The B2B design writes one row per buyer when a price list changes (the fan-out in LB-2). Cost is rows written, at 1,000 times the price of rows read (PLATFORM-GOAL), so this is the direct cost the north star warns about. P1 removes it.
- **Data exposure.** Renewals need all four protected-data scopes only because `orders.create` takes contact fields instead of a `customerId` (B2B-2). Fix the operation and the scopes drop to none.
- **Rate limits.** Each public island call is one Worker run plus a D1 read per page view (LOY-2). There are 60 webhook calls a minute per client and route, so an ERP behind one egress IP must batch. My `erp-sync` takes 24 SKUs per batch write and an inbox per delivery.

---

## Sources

- [Shopify subscriptions overview](https://shopify.dev/docs/apps/build/purchase-options/subscriptions/index) and [subscription APIs (Partners blog)](https://www.shopify.com/partners/blog/shopify-subscription-apis)
- [Shopify Cart Transform Function API](https://shopify.dev/docs/api/functions/latest/cart-transform) and [lineUpdate changelog](https://shopify.dev/changelog/developer-preview-cart-transform-api-updating-lines-in-the-cart)
- [Shopify theme app extensions framework](https://shopify.dev/docs/apps/online-store/theme-app-extensions/extensions-framework); [cart drawer app blocks thread](https://community.shopify.com/t/is-there-a-way-to-add-app-blocks-into-cart-drawers/108259)
- [inventorySetQuantities, 250 per call (Shopify dev forum)](https://community.shopify.dev/t/update-inventory-in-bulk-using-bulkoperationrunmutation/14926)
- Shopify B2B catalogs, quantity rules and payment terms, as summarized by [eseospace](https://eseospace.com/blog/shopify-b2b/) and [upsolite](https://upsolite.com/blogs/insights/native-b2b-on-shopify-in-2026-whats-built-in-vs-what-still-needs-custom-work). These are third-party summaries; verify plan limits against Shopify's docs.
- [Medusa marketplace recipe](https://docs.medusajs.com/resources/recipes/marketplace) and [vendors example](https://docs.medusajs.com/resources/recipes/marketplace/examples/vendors); [Medusa scheduled jobs](https://docs.medusajs.com/learn/basics/scheduled-jobs)
- [Vendure multi-vendor marketplaces](https://docs.vendure.io/guides/how-to/multi-vendor-marketplaces/), [channels](https://docs.vendure.io/guides/core-concepts/channels/), [OrderItemPriceCalculationStrategy](https://docs.vendure.io/reference/typescript-api/orders/order-item-price-calculation-strategy/), [configurable products](https://docs.vendure.io/guides/how-to/configurable-products/)
