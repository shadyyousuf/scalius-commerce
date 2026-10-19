// Pure rules shared by the functions and the routes. Everything money is
// integer minor units, as function inputs are.

/**
 * The buyer's membership record (`acme.wholesale.members`, record id = the
 * customer id). HACK: function snapshots read one record of one object type
 * keyed by customer id, so a company's price list, its minimum quantities
 * and every approved quote are copied into each member's record. A company
 * with 40 buyers stores its price list 40 times, and the 64 KiB record cap
 * bounds a price list to roughly 1,500 SKUs (DX-REPORT B2B-1).
 */
export interface Membership {
  company_id: string;
  company_name: string;
  terms: "prepaid" | "net30";
  /** variantId -> unit price in minor units. */
  prices: Record<string, number>;
  /** variantId -> minimum order quantity. */
  moq: Record<string, number>;
  /** quote code -> approved discount on the order, in minor units, not yet used. */
  approved_quotes: Record<string, number>;
}

export function membershipOf(data: Record<string, unknown> | null | undefined): Membership | null {
  if (!data || typeof data.company_id !== "string") return null;
  const map = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0));
  };
  return {
    company_id: data.company_id,
    company_name: typeof data.company_name === "string" ? data.company_name : "",
    terms: data.terms === "net30" ? "net30" : "prepaid",
    prices: map(data.prices),
    moq: map(data.moq),
    approved_quotes: map(data.approved_quotes),
  };
}

/**
 * Minimum order quantities from the app settings (`SKU=quantity` per line).
 * HACK: `cart.validate` gets no snapshot and no product custom fields
 * (functions.ts PLUGIN_FUNCTION_SCHEMAS["cart.validate"]), so a per-company
 * or per-product minimum cannot reach it; a store-wide text setting is the
 * only input left.
 */
export function parseMoqRules(text: string): Map<string, number> {
  const rules = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^=\s]+)\s*=\s*(\d{1,6})\s*$/.exec(line);
    if (match) rules.set(match[1]!.toLowerCase(), Number(match[2]));
  }
  return rules;
}

export interface QuoteLine { variantId: string; quantity: number; note?: string }

/** A quote request a buyer posts from the proxy page; lines come from a form. */
export function parseQuoteForm(body: unknown): { lines: QuoteLine[]; note: string } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Send the quote as a form." };
  const fields = body as Record<string, unknown>;
  const lines: QuoteLine[] = [];
  for (let index = 0; index < 20; index += 1) {
    const variantId = fields[`variant_${index}`];
    const quantity = Number(fields[`quantity_${index}`]);
    if (typeof variantId !== "string" || variantId.trim() === "") continue;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) return { error: `Line ${index + 1}: enter a whole quantity.` };
    lines.push({ variantId: variantId.trim().slice(0, 128), quantity });
  }
  if (lines.length === 0) return { error: "Add at least one product." };
  const note = typeof fields.note === "string" ? fields.note.slice(0, 1000) : "";
  return { lines, note };
}

export function quoteCode(quoteId: string): string {
  return `Q-${quoteId.replace(/[^A-Za-z0-9]/g, "").slice(-10).toUpperCase()}`;
}
