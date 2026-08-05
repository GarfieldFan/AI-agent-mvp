import type { Metadata } from "next";

import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { CteEditorPanel } from "@/components/modules/cte-editor-panel";

export const metadata: Metadata = {
  title: "Page Editor",
  description: "Click-to-edit page editor.",
};

export default function EditorPage() {
  return (
    <Container className="space-y-8 py-12">
      <PageHeader
        title="Click-to-Edit (CTE)"
        description="Load a saved page, flip on Edit mode, and click a pencil badge to edit that text, image, or button — then save as a new version."
      />
      <CteEditorPanel />
    </Container>
  );
}
