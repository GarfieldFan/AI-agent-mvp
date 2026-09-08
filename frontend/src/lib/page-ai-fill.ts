import { apiFetch } from "@/lib/api";
import type { Block, FeatureItem, PageSection, RichText, ThemeCta, ThemeImage } from "@/lib/theme";

export type FillableFieldKind = "text" | "image" | "text-list";

/** One content slot in the owner's already-arranged layout, collected by
 * `collectFillableFields` below and sent to
 * `POST /api/agent/pages/ai-fill-content`. `path` is a dot-path into the
 * live `sections` tree (lib/cte.ts's setByPath shape) — opaque to the
 * backend, which only ever echoes it back. `richText` carries the field's
 * current color/size/weight (when it's already a `RichText` object, not a
 * plain string) so applying an AI-generated result can preserve those
 * style overrides instead of silently discarding them. */
export type FillableField = {
  path: string;
  kind: FillableFieldKind;
  label: string;
  currentValue: string;
  richText?: { color?: string; size?: number; weight?: RichText["weight"] };
};

export type AiFillResult = { path: string; value: string };

/** POST /api/agent/pages/ai-fill-content — admin/owner. Backend never sees
 * the page schema itself, only this flat field manifest (see
 * backend/apis/agent.py's module comment above the endpoint for why) —
 * the frontend is what decides which fields exist and what applying a
 * result back means. */
export function requestAiFillContent(prompt: string, fields: FillableField[]) {
  return apiFetch<{ fields: AiFillResult[] }>("/api/agent/pages/ai-fill-content", {
    method: "POST",
    body: {
      prompt,
      fields: fields.map((f) => ({
        path: f.path,
        kind: f.kind,
        label: f.label,
        current_value: f.currentValue,
      })),
    },
  });
}

function textOf(value: string | RichText | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.content;
}

function richTextOf(value: string | RichText | undefined): FillableField["richText"] | undefined {
  if (!value || typeof value === "string") return undefined;
  const { color, size, weight } = value;
  if (color === undefined && size === undefined && weight === undefined) return undefined;
  return { color, size, weight };
}

function pushText(fields: FillableField[], path: string, label: string, value: string | RichText | undefined) {
  fields.push({ path, kind: "text", label, currentValue: textOf(value), richText: richTextOf(value) });
}

function pushImage(fields: FillableField[], path: string, label: string, value: ThemeImage | undefined) {
  fields.push({ path, kind: "image", label, currentValue: value?.alt ?? "" });
}

function pushTextList(fields: FillableField[], path: string, label: string, values: string[] | undefined) {
  fields.push({ path, kind: "text-list", label, currentValue: (values ?? []).join(" | ") });
}

function walkCtas(fields: FillableField[], ctas: ThemeCta[] | undefined, basePath: string, sectionLabel: string) {
  (ctas ?? []).forEach((cta, i) => {
    pushText(fields, `${basePath}.${i}.label`, `${sectionLabel} — button ${i + 1} label`, cta.label);
  });
}

function walkFeatureItems(fields: FillableField[], items: FeatureItem[], basePath: string, sectionLabel: string) {
  items.forEach((item, i) => {
    pushText(fields, `${basePath}.${i}.title`, `${sectionLabel} — item ${i + 1} title`, item.title);
    pushText(fields, `${basePath}.${i}.description`, `${sectionLabel} — item ${i + 1} description`, item.description);
    if (item.image) pushImage(fields, `${basePath}.${i}.image`, `${sectionLabel} — item ${i + 1} image`, item.image);
  });
}

/** Blocks that hold owner-picked *data* (a product, a map address), not
 * freeform copy — never offered to the AI-fill step. Same "structural/
 * factual fields are never AI-written" boundary this app already draws
 * elsewhere (e.g. MapBlock.query, ButtonBlock.href). */
function walkBlock(fields: FillableField[], block: Block, path: string, sectionLabel: string) {
  switch (block.type) {
    case "image":
      pushImage(fields, `${path}.image`, `${sectionLabel} — image`, block.image);
      return;
    case "text":
      pushText(fields, `${path}.content`, `${sectionLabel} — text`, block.content);
      return;
    case "button":
      pushText(fields, `${path}.label`, `${sectionLabel} — button label`, block.label);
      return;
    case "container":
      if (block.background_image) {
        pushImage(fields, `${path}.background_image`, `${sectionLabel} — background image`, block.background_image);
      }
      block.children.forEach((child, i) => walkBlock(fields, child, `${path}.children.${i}`, sectionLabel));
      return;
    case "product-list":
    case "product-card":
    case "map":
      return;
  }
}

/** Walks the owner's already-arranged `sections` tree and returns every
 * content slot the AI-fill step can offer to write — text, text-lists
 * (badges), and image-prompt suggestions. Deliberately skips anything
 * structural (layout/type/columns/width), functional (href, product
 * bindings, a map's real address), or already-generated-content-bearing
 * (CarouselSection — not CTE-insertable/editable at all, see
 * lib/section-registry.ts) — this only ever offers fields a human would
 * otherwise type into a CteEditorPopover text box. */
export function collectFillableFields(sections: PageSection[]): FillableField[] {
  const fields: FillableField[] = [];

  sections.forEach((section, index) => {
    const path = String(index);
    switch (section.type) {
      case "hero":
        pushText(fields, `${path}.eyebrow`, "Hero — eyebrow (optional small tagline above the headline)", section.eyebrow);
        pushText(fields, `${path}.headline`, "Hero — headline", section.headline);
        pushText(fields, `${path}.subheadline`, "Hero — subheadline", section.subheadline);
        walkCtas(fields, section.ctas, `${path}.ctas`, "Hero");
        if (section.image) pushImage(fields, `${path}.image`, "Hero — image", section.image);
        return;
      case "feature-grid":
        pushText(fields, `${path}.heading`, "Feature grid — heading", section.heading);
        pushText(fields, `${path}.subheading`, "Feature grid — subheading", section.subheading);
        if (section.layout === "split") {
          pushText(fields, `${path}.body`, "Feature grid — supporting paragraph", section.body);
        }
        if (section.cta) pushText(fields, `${path}.cta.label`, "Feature grid — button label", section.cta.label);
        walkFeatureItems(fields, section.items, `${path}.items`, "Feature grid");
        return;
      case "text-block":
        pushText(fields, `${path}.heading`, "Text block — heading", section.heading);
        pushText(fields, `${path}.body`, "Text block — body", section.body);
        if (section.image) pushImage(fields, `${path}.image`, "Text block — image", section.image);
        if (section.background_image) {
          pushImage(fields, `${path}.background_image`, "Text block — background image", section.background_image);
        }
        return;
      case "cta-banner":
        pushText(fields, `${path}.heading`, "CTA banner — heading", section.heading);
        pushText(fields, `${path}.body`, "CTA banner — body", section.body);
        walkCtas(fields, section.ctas, `${path}.ctas`, "CTA banner");
        return;
      case "badge-list":
        pushText(fields, `${path}.heading`, "Badge list — heading", section.heading);
        pushTextList(fields, `${path}.badges`, "Badge list — badges", section.badges);
        return;
      case "carousel":
        return;
      case "container":
        if (section.background_image) {
          pushImage(fields, `${path}.background_image`, "Container — background image", section.background_image);
        }
        section.children.forEach((child, i) => walkBlock(fields, child, `${path}.children.${i}`, "Container"));
        return;
    }
  });

  return fields;
}
