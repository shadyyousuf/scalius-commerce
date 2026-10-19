// A headless Next.js storefront's data layer, on the public storefront API
// through packages/api-client. Framework-free so it typechecks without Next.
//
// HACK: @scalius/api-client is `private: true` (packages/api-client/package.json),
// so an outside team vendors it or regenerates it from /api/v1/openapi.json
// (DX-REPORT HL-1). Operation names are derived from paths
// (getApiV1ProductsBySlug, postApiV1Orders), not stable operation ids.

import {
  createHttpClient,
  getApiV1CheckoutConfig,
  getApiV1ProductsBySlug,
  getApiV1StorefrontBatch,
  postApiV1Orders,
  postApiV1OrdersCartValidation,
  postApiV1OrdersTaxQuote,
  type GetApiV1ProductsBySlugResponses,
  type PostApiV1OrdersData,
  type PostApiV1OrdersTaxQuoteResponses,
} from "@scalius/api-client";

export type Product = GetApiV1ProductsBySlugResponses[200]["data"]["product"];
export type Quote = PostApiV1OrdersTaxQuoteResponses[200]["data"];

/** One client per server process; the store API origin is public configuration. */
export function storeClient(baseUrl: string) {
  return createHttpClient({ baseUrl });
}

type Client = ReturnType<typeof storeClient>;

export async function product(client: Client, slug: string, presence?: string): Promise<Product | null> {
  const result = await getApiV1ProductsBySlug({ client, path: { slug }, query: presence ? { presence } : undefined });
  return result.data?.data.product ?? null;
}

/**
 * The storefront's own page read: one batch, many parts. HACK: each part's
 * body arrives as a JSON string typed `string`, so every part is parsed and
 * cast by hand; the generated types cannot describe it (DX-REPORT HL-2).
 */
export async function batch<T extends unknown[]>(client: Client, parts: string[]): Promise<{ [K in keyof T]: T[K] | null }> {
  const result = await getApiV1StorefrontBatch({ client, query: { r: parts } });
  const bodies = result.data?.data.parts ?? [];
  return parts.map((_, index) => {
    const part = bodies[index];
    if (!part || part.status !== 200) return null;
    try {
      return (JSON.parse(part.body) as { data?: unknown }).data ?? null;
    } catch {
      return null;
    }
  }) as { [K in keyof T]: T[K] | null };
}

/** A cart is the client's own state: the API has no cart resource (DX-REPORT HL-3). */
export interface CartLine {
  productId: string;
  variantId: string;
  quantity: number;
  /** The decimal major-unit price the buyer saw: the API asks the client to echo it. */
  price: number;
  properties?: Array<{ key: string; value: string }>;
}

export async function validateCart(client: Client, lines: CartLine[]) {
  const result = await postApiV1OrdersCartValidation({ client, body: { items: lines } });
  return result.data ?? null;
}

export async function quote(client: Client, lines: CartLine[], destination: { country: string; postalCode?: string }, codes: string[] = []): Promise<Quote | null> {
  const result = await postApiV1OrdersTaxQuote({
    client,
    body: { items: lines, shippingCountryCode: destination.country, shippingPostalCode: destination.postalCode ?? null, discountCodes: codes },
  });
  return result.data?.data ?? null;
}

export async function paymentMethods(client: Client) {
  const result = await getApiV1CheckoutConfig({ client });
  return result.data ?? null;
}

type OrderBody = NonNullable<PostApiV1OrdersData["body"]>;

/**
 * Places the order the buyer reviewed. `checkoutRequestId` is the
 * idempotency key; `expectedQuoteFingerprint` binds it to the quote shown.
 * HACK: money crosses as decimal major units (`price`, `shippingCharge`)
 * while the quote answers minor units too (DX-REPORT HL-4).
 */
export async function placeOrder(client: Client, input: {
  requestId: string;
  quote: Quote;
  lines: CartLine[];
  buyer: { name: string; email: string | null; phone: string | null };
  address: { country: string; line1: string; locality: string; postalCode?: string };
  paymentMethod: string;
}) {
  const body: OrderBody = {
    checkoutRequestId: input.requestId,
    expectedQuoteFingerprint: input.quote.quoteFingerprint,
    customerName: input.buyer.name,
    customerEmail: input.buyer.email,
    customerPhone: input.buyer.phone,
    shippingCountryCode: input.address.country,
    shippingAddress: input.address.line1,
    shippingLocality: input.address.locality,
    shippingPostalCode: input.address.postalCode ?? null,
    notes: null,
    items: input.lines,
    shippingCharge: input.quote.shippingAmount,
    shippingMethodId: input.quote.shippingMethod?.id ?? null,
    shippingRateToken: input.quote.shippingRateToken,
    paymentMethod: input.paymentMethod,
    expectedAmountDueMinor: input.quote.amountDueMinor,
  };
  const result = await postApiV1Orders({ client, body });
  return result.data?.data ?? null;
}

/**
 * Apps' Buyer UI arrives with the quote as data. A headless client must draw
 * the node tree itself, without the core renderer the Astro storefront uses
 * (apps/storefront/src/lib/buyer-ui): no SDK ships one (DX-REPORT HL-5).
 */
export function buyerUiText(quote: Quote): string[] {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const value = node as { type?: string; text?: string; title?: string; children?: unknown[] };
    if (typeof value.text === "string") texts.push(value.text);
    else if (typeof value.title === "string") texts.push(value.title);
    value.children?.forEach(walk);
  };
  quote.buyerUi.forEach((block) => walk(block.ui));
  return texts;
}
