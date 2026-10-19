"use server";
// Next.js server action (code only; excluded from the scratch typecheck).
import { cookies } from "next/headers";
import { paymentMethods, placeOrder, quote, storeClient, type CartLine } from "../../lib/scalius";

const client = storeClient(process.env.SCALIUS_API_ORIGIN!);

export async function checkout(form: FormData) {
  // The cart lives in our own cookie: the API keeps none.
  const lines = JSON.parse((await cookies()).get("cart")?.value ?? "[]") as CartLine[];
  const country = String(form.get("country"));
  const reviewed = await quote(client, lines, { country, postalCode: String(form.get("postalCode") ?? "") });
  if (!reviewed) return { error: "Could not price the cart." };
  const config = await paymentMethods(client);
  const method = (config as { data?: { gateways?: Array<{ id: string }> } } | null)?.data?.gateways?.[0]?.id;
  if (!method) return { error: "No payment method is available." };
  // HACK: a hosted payment redirects back to the store's own /api/v1/payment/<provider>/success,
  // which lands on the Astro storefront's receipt, not this app (DX-REPORT HL-7).
  const order = await placeOrder(client, {
    requestId: crypto.randomUUID(),
    quote: reviewed,
    lines,
    buyer: { name: String(form.get("name")), email: String(form.get("email") || "") || null, phone: String(form.get("phone") || "") || null },
    address: { country, line1: String(form.get("line1")), locality: String(form.get("city")) },
    paymentMethod: method,
  });
  return order ? { orderId: order.orderId } : { error: "The order was not placed." };
}
