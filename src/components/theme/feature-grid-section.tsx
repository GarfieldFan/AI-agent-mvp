import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Badge } from "@/components/ui/badge";
import { ModuleCard } from "@/components/common/module-card";
import { AddItemButton } from "@/components/theme/cte/add-item-button";
import { Editable } from "@/components/theme/cte/editable";
import { resolveIcon } from "@/components/theme/icon-registry";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import type { FeatureGridSection as FeatureGridSectionData, FeatureItem } from "@/lib/theme";

const NEW_FEATURE_ITEM: FeatureItem = { title: "New card", description: "Description goes here.", href: "#" };

const COLUMN_CLASS: Record<NonNullable<FeatureGridSectionData["columns"]>, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

// Only used when the item has a real photo — otherwise ModuleCard (below)
// handles it and keeps its hover-arrow/"Planned"-pill polish. Not built on
// `Card`: Card's image-aware styling assumes a literal `<img>` first
// child, but this needs to show a placeholder `<div>` (via
// ThemeImageBox) just as often as a real `<img>`.
function FeatureCardWithImage({ item }: { item: FeatureItem }) {
  return (
    <Link href={item.href} className="group block h-full">
      <div className="flex h-full flex-col overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 transition-colors group-hover:bg-muted/40">
        <div className="aspect-[16/10] w-full">
          <ThemeImageBox image={item.image} />
        </div>
        <div className="flex flex-1 flex-col gap-1 p-4">
          {item.badge ? (
            <Badge variant="outline" className="mb-1 w-fit text-xs text-muted-foreground">
              {item.badge}
            </Badge>
          ) : null}
          <p className="font-heading text-base font-medium leading-snug">{item.title}</p>
          <p className="text-sm text-muted-foreground">{item.description}</p>
        </div>
      </div>
    </Link>
  );
}

function FeatureCard({ item }: { item: FeatureItem }) {
  if (item.image) {
    return <FeatureCardWithImage item={item} />;
  }
  return (
    <ModuleCard
      href={item.href}
      icon={resolveIcon(item.icon)}
      title={item.title}
      description={item.description}
      status={item.badge === "Planned" ? "planned" : "live"}
    />
  );
}

// Edits the whole item (title + description, + image if it has one) as one
// unit rather than instrumenting ModuleCard/FeatureCardWithImage's inner
// text nodes individually — those components are shared elsewhere (see
// ModuleCard's doc comment) and shouldn't carry CTE-specific logic.
function EditableFeatureCard({ item, sectionIndex, itemIndex }: { item: FeatureItem; sectionIndex: number; itemIndex: number }) {
  return (
    <Editable as="div" path={`${sectionIndex}.items.${itemIndex}`} fieldType="feature-item" value={item}>
      <FeatureCard item={item} />
    </Editable>
  );
}

type FeatureGridSectionProps = FeatureGridSectionData & { sectionIndex: number };

export function FeatureGridSection({
  sectionIndex,
  heading,
  subheading,
  items,
  columns = 3,
  layout = "stacked",
}: FeatureGridSectionProps) {
  const headingBlock =
    heading || subheading ? (
      <div className="space-y-1">
        {heading ? (
          <h2 className="text-xl font-semibold">
            <Editable path={`${sectionIndex}.heading`} fieldType="text" value={heading}>
              {heading}
            </Editable>
          </h2>
        ) : null}
        {subheading ? (
          <p className="text-sm text-muted-foreground">
            <Editable path={`${sectionIndex}.subheading`} fieldType="text" value={subheading}>
              {subheading}
            </Editable>
          </p>
        ) : null}
      </div>
    ) : null;

  if (layout === "split") {
    return (
      <section>
        <Container className="grid gap-8 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-start">
          {headingBlock}
          {/* Capped at 2 columns regardless of `columns` — a split layout's
             grid only gets ~2/3 of the container width, so 3-4 columns
             would cramp badly. */}
          <div className="grid gap-4 sm:grid-cols-2">
            {items.map((item, itemIndex) => (
              <EditableFeatureCard key={item.title} item={item} sectionIndex={sectionIndex} itemIndex={itemIndex} />
            ))}
            <AddItemButton
              path={`${sectionIndex}.items`}
              fieldType="feature-item"
              defaultValue={NEW_FEATURE_ITEM}
              label="Add card"
              className="min-h-[8rem]"
            />
          </div>
        </Container>
      </section>
    );
  }

  return (
    <section>
      <Container className="space-y-6 py-16">
        {headingBlock}
        <div className={`grid gap-4 ${COLUMN_CLASS[columns]}`}>
          {items.map((item, itemIndex) => (
            <EditableFeatureCard key={item.title} item={item} sectionIndex={sectionIndex} itemIndex={itemIndex} />
          ))}
          <AddItemButton
            path={`${sectionIndex}.items`}
            fieldType="feature-item"
            defaultValue={NEW_FEATURE_ITEM}
            label="Add card"
            className="min-h-[8rem]"
          />
        </div>
      </Container>
    </section>
  );
}
