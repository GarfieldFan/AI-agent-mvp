import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Container } from "@/components/layout/container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ModuleCard } from "@/components/common/module-card";
import { AddItemButton } from "@/components/theme/cte/add-item-button";
import { ArrayItemToolbar } from "@/components/theme/cte/array-item-toolbar";
import { Editable } from "@/components/theme/cte/editable";
import { resolveIcon } from "@/components/theme/icon-registry";
import { resolveRichText, richTextStyle } from "@/components/theme/rich-text";
import { themeButtonClassName, themeCtaStyle } from "@/components/theme/theme-cta-style";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import type { FeatureGridSection as FeatureGridSectionData, FeatureItem } from "@/lib/theme";

const NEW_FEATURE_ITEM: FeatureItem = { title: "New card", description: "Description goes here.", href: "#" };

// Flexbox, not CSS Grid, for the "stacked" item row below — deliberately.
// Grid's auto-placement keeps every row locked to the same N columns even
// when the last row has fewer items than that (5 items at columns:3 left
// the last row's 2 cards each at a fixed 1/3 width with an empty 1/3 gap,
// instead of the 1/2+1/2 a real design would show). `grow` on each item
// makes a short last row's items expand to fill exactly the space that
// row actually has, since flex-wrap treats each wrapped row as its own
// line for both `grow` distribution and the default stretch-to-tallest
// cross-axis sizing (the same per-row height behavior Grid gave us).
const ITEM_BASIS_CLASS: Record<NonNullable<FeatureGridSectionData["columns"]>, string> = {
  2: "basis-full sm:basis-[calc(50%-0.5rem)]",
  3: "basis-full sm:basis-[calc(50%-0.5rem)] lg:basis-[calc(33.333%-0.667rem)]",
  4: "basis-full sm:basis-[calc(50%-0.5rem)] lg:basis-[calc(25%-0.75rem)]",
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

// Added 2026-08-05 — testimonial/review pattern (round profile photo +
// name + quote). Not a link (unlike the other FeatureCard variants):
// testimonials aren't navigation targets, `item.href` goes unused here.
function FeatureCardAvatar({ item }: { item: FeatureItem }) {
  return (
    <div className="flex h-full flex-col gap-3 rounded-xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
      <div className="flex items-center gap-3">
        <div className="size-10 shrink-0 overflow-hidden rounded-full">
          <ThemeImageBox image={item.image} />
        </div>
        <p className="font-heading text-sm font-medium">{item.title}</p>
      </div>
      <p className="text-sm text-muted-foreground">{item.description}</p>
    </div>
  );
}

// Added 2026-08-05 — for designs where repeated items aren't cards at
// all (no border/rounded/background), just stacked photo+text within the
// same grid/row arrangement "card" style uses. `imagePosition` covers the
// two orders actually seen so far (photo above the text, or below it) —
// see the root AGENTS.md's feature-grid item_style entry for why this
// exists alongside the original card variants rather than replacing them.
function PlainFeatureItem({ item, imagePosition }: { item: FeatureItem; imagePosition: "top" | "bottom" }) {
  const imageBlock = item.image ? (
    <div className="aspect-[16/10] w-full overflow-hidden rounded-lg">
      <ThemeImageBox image={item.image} />
    </div>
  ) : null;
  const textBlock = (
    <div className="flex flex-col gap-1">
      <p className="font-heading text-base font-medium leading-snug">{item.title}</p>
      <p className="text-sm text-muted-foreground">{item.description}</p>
    </div>
  );
  return (
    <div className="flex h-full flex-col gap-3">
      {imagePosition === "top" ? imageBlock : null}
      {textBlock}
      {imagePosition === "bottom" ? imageBlock : null}
    </div>
  );
}

// Added 2026-08-05 — a single-column list row (small square photo left,
// text right), for designs where repeated items read as a divided list
// rather than a grid at all. Ignores `columns` entirely — see
// `FeatureGridSection`'s `item_style === "list"` branch below, which
// renders these full-width in one column regardless of `layout`.
function ListFeatureItem({ item }: { item: FeatureItem }) {
  return (
    <div className="flex items-center gap-4 py-4">
      {item.image ? (
        <div className="aspect-square w-16 shrink-0 overflow-hidden rounded-md">
          <ThemeImageBox image={item.image} />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="font-heading text-base font-medium leading-snug">{item.title}</p>
        <p className="text-sm text-muted-foreground">{item.description}</p>
      </div>
    </div>
  );
}

function FeatureCard({
  item,
  itemStyle,
  itemImagePosition,
}: {
  item: FeatureItem;
  itemStyle: NonNullable<FeatureGridSectionData["item_style"]>;
  itemImagePosition: NonNullable<FeatureGridSectionData["item_image_position"]>;
}) {
  if (itemStyle === "list") {
    return <ListFeatureItem item={item} />;
  }
  if (itemStyle === "plain") {
    return <PlainFeatureItem item={item} imagePosition={itemImagePosition} />;
  }
  if (item.image && item.image_style === "avatar") {
    return <FeatureCardAvatar item={item} />;
  }
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
function EditableFeatureCard({
  item,
  sectionIndex,
  itemIndex,
  itemCount,
  itemStyle,
  itemImagePosition,
}: {
  item: FeatureItem;
  sectionIndex: number;
  itemIndex: number;
  itemCount: number;
  itemStyle: NonNullable<FeatureGridSectionData["item_style"]>;
  itemImagePosition: NonNullable<FeatureGridSectionData["item_image_position"]>;
}) {
  const path = `${sectionIndex}.items.${itemIndex}`;
  return (
    <div className="group relative h-full">
      <ArrayItemToolbar path={path} disableBack={itemIndex === 0} disableForward={itemIndex === itemCount - 1} />
      <Editable as="div" path={path} fieldType="feature-item" value={item} className="h-full">
        <FeatureCard item={item} itemStyle={itemStyle} itemImagePosition={itemImagePosition} />
      </Editable>
    </div>
  );
}

type FeatureGridSectionProps = FeatureGridSectionData & { sectionIndex: number };

export function FeatureGridSection({
  sectionIndex,
  heading,
  subheading,
  body,
  cta,
  items,
  columns = 3,
  layout = "stacked",
  item_style = "card",
  item_image_position = "top",
}: FeatureGridSectionProps) {
  const headingRt = heading ? resolveRichText(heading) : null;
  const subheadingRt = subheading ? resolveRichText(subheading) : null;
  const bodyRt = body ? resolveRichText(body) : null;

  const headingBlock =
    heading || subheading || body || cta ? (
      <div className="space-y-4">
        {heading || subheading ? (
          <div className="space-y-1">
            {headingRt ? (
              <h2 className="text-xl font-semibold" style={richTextStyle(headingRt)}>
                <Editable path={`${sectionIndex}.heading`} fieldType="rich-text" value={headingRt}>
                  {headingRt.content}
                </Editable>
              </h2>
            ) : null}
            {subheadingRt ? (
              <p className="text-sm text-muted-foreground" style={richTextStyle(subheadingRt)}>
                <Editable path={`${sectionIndex}.subheading`} fieldType="rich-text" value={subheadingRt}>
                  {subheadingRt.content}
                </Editable>
              </p>
            ) : null}
          </div>
        ) : null}
        {/* body/cta: only meaningful for layout "split" (a left column with
           room for more than a heading), but harmless if set elsewhere. */}
        {bodyRt ? (
          <p className="text-sm text-muted-foreground" style={richTextStyle(bodyRt)}>
            <Editable path={`${sectionIndex}.body`} fieldType="rich-text" value={bodyRt}>
              {bodyRt.content}
            </Editable>
          </p>
        ) : null}
        {cta ? (
          <Editable as="div" path={`${sectionIndex}.cta`} fieldType="cta" value={cta}>
            <Button
              size={cta.size ?? "default"}
              nativeButton={false}
              render={<Link href={cta.href} />}
              className={themeButtonClassName(cta)}
              style={themeCtaStyle(cta)}
            >
              {cta.label}
            </Button>
          </Editable>
        ) : null}
      </div>
    ) : null;

  let itemsArea: ReactNode;
  if (item_style === "list") {
    // Ignores `columns`/`layout`'s grid arrangement entirely — a single
    // full-width column of divided rows, not a grid.
    itemsArea = (
      <div className="divide-y divide-border">
        {items.map((item, itemIndex) => (
          <EditableFeatureCard
            key={itemIndex}
            item={item}
            sectionIndex={sectionIndex}
            itemIndex={itemIndex}
            itemCount={items.length}
            itemStyle={item_style}
            itemImagePosition={item_image_position}
          />
        ))}
        <AddItemButton
          path={`${sectionIndex}.items`}
          fieldType="feature-item"
          defaultValue={NEW_FEATURE_ITEM}
          label="Add item"
          className="w-full py-4"
        />
      </div>
    );
  } else if (layout === "split") {
    // Capped at 2 columns regardless of `columns` — a split layout's grid
    // only gets ~2/3 of the container width, so 3-4 columns would cramp.
    itemsArea = (
      <div className="grid gap-4 sm:grid-cols-2">
        {items.map((item, itemIndex) => (
          <EditableFeatureCard
            key={itemIndex}
            item={item}
            sectionIndex={sectionIndex}
            itemIndex={itemIndex}
            itemCount={items.length}
            itemStyle={item_style}
            itemImagePosition={item_image_position}
          />
        ))}
        <AddItemButton
          path={`${sectionIndex}.items`}
          fieldType="feature-item"
          defaultValue={NEW_FEATURE_ITEM}
          label="Add card"
          className="min-h-[8rem]"
        />
      </div>
    );
  } else {
    itemsArea = (
      <div className="flex flex-wrap gap-4">
        {items.map((item, itemIndex) => (
          <div key={itemIndex} className={cn("grow", ITEM_BASIS_CLASS[columns])}>
            <EditableFeatureCard
              item={item}
              sectionIndex={sectionIndex}
              itemIndex={itemIndex}
              itemCount={items.length}
              itemStyle={item_style}
              itemImagePosition={item_image_position}
            />
          </div>
        ))}
        {/* Classes applied directly to AddItemButton's own root element,
           NOT a wrapping div — AddItemButton renders nothing at all
           (returns null) outside edit mode, and a wrapping div would
           still occupy a real flex slot even then. That's exactly the
           bug this comment is replacing: on every public page, an
           "invisible" 6th flex item silently turned "5 items -> a
           3-card row + a 2-card row" into "6 slots -> two full 3-card
           rows," which meant the short-row-grow fix above never
           actually had a short row to grow into. */}
        <AddItemButton
          path={`${sectionIndex}.items`}
          fieldType="feature-item"
          defaultValue={NEW_FEATURE_ITEM}
          label="Add card"
          className={cn("grow min-h-[8rem]", ITEM_BASIS_CLASS[columns])}
        />
      </div>
    );
  }

  if (layout === "split") {
    return (
      <section>
        <Container className="grid gap-8 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-start">
          {headingBlock}
          {itemsArea}
        </Container>
      </section>
    );
  }

  return (
    <section>
      <Container className="space-y-6 py-16">
        {headingBlock}
        {itemsArea}
      </Container>
    </section>
  );
}
