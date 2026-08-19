import { notFound } from "next/navigation";

import { ProductDetail } from "@/components/modules/product-detail";
import { getPublicProduct, listPublicProductFields } from "@/lib/products";

// Same reasoning as app/p/[slug]/page.tsx: fetch fresh on every request
// so a saved price/availability change shows up immediately.
export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const productId = Number(id);
  if (!Number.isInteger(productId)) {
    notFound();
  }

  const [product, fieldDefinitions] = await Promise.all([
    getPublicProduct(productId),
    listPublicProductFields().catch(() => []),
  ]);

  if (!product) {
    notFound();
  }

  return <ProductDetail product={product} fieldDefinitions={fieldDefinitions} />;
}
