import type { Metadata } from "next";

import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { EditorTabs } from "@/components/modules/editor-tabs";

export const metadata: Metadata = {
  title: "Page Editor",
  description: "Click-to-edit page editor and site menu.",
};

// `?tab=menu` opens the Menu tab, `?slug=` preloads a page — both linked
// from AdminBar ("Menu", "Edit this page").
export default async function EditorPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string }>;
}) {
  // `?tab=` is read client-side by EditorTabs itself (it has to react to
  // same-route URL changes); only the initial slug is needed here.
  const { slug } = await searchParams;

  return (
    <Container className="space-y-8 py-12">
      <PageHeader
        title="Page Editor"
        description="Edit your pages in place (load a page, turn on Edit mode, click a pencil badge, save as a new version), and manage the menu visitors see in the site header and footer."
      />
      <EditorTabs initialSlug={slug || undefined} />
    </Container>
  );
}
