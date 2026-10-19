// Next.js App Router product page (code only: Next and React are not installed
// in this fork, so this file is excluded from the scratch typecheck).
import { notFound } from "next/navigation";
import { product, storeClient } from "../../../lib/scalius";

const client = storeClient(process.env.SCALIUS_API_ORIGIN!);

export const revalidate = 60; // HACK: no webhook-driven revalidation contract for headless caches (DX-REPORT HL-6)

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const item = await product(client, slug);
  if (!item) notFound();
  return (
    <main>
      <h1>{item.name}</h1>
      {/* Decimal major units; the client formats money itself, without the store's locale-format rules. */}
      <p>{item.price}</p>
      <form action="/cart/add" method="post">
        <input type="hidden" name="productId" value={item.id} />
        <button type="submit">Add to bag</button>
      </form>
    </main>
  );
}
