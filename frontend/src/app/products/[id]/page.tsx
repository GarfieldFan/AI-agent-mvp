import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ProductDetail } from "@/components/modules/product-detail";
import { buildProductJsonLd, getPublicProduct, listPublicProductFields } from "@/lib/products";

// Same reasoning as app/p/[slug]/page.tsx: fetch fresh on every request
// so a saved price/availability change shows up immediately.
export const dynamic = "force-dynamic";

function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

// 2026-09-08 — closes a real GEO gap: this page used to inherit only the
// site-wide LocalBusiness title/description (root layout's
// generateMetadata), never naming the actual product. See the root
// AGENTS.md's GEO/business-profile section.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const productId = Number(id);
  if (!Number.isInteger(productId)) return {};

  const product = await getPublicProduct(productId);
  if (!product) return {};

  const description = product.description || `${product.name} — $${product.price.toFixed(2)}`;
  return {
    title: product.name,
    description,
    openGraph: {
      title: product.name,
      description,
      ...(product.image_url ? { images: [{ url: product.image_url }] } : {}),
    },
  };
}

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

  const jsonLd = buildProductJsonLd(product, siteUrl());

  return (
    <>
      {/* Standard Next.js App Router JSON-LD pattern, same as SiteJsonLd —
          built entirely from this app's own owner-entered Product data
          (JSON.stringify of a plain data object), never third-party HTML. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <ProductDetail product={product} fieldDefinitions={fieldDefinitions} />
    </>
  );
}
