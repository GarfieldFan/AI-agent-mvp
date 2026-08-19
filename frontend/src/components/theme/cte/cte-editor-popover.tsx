"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ColorField } from "@/components/theme/cte/color-field";
import { ImageFieldEditor } from "@/components/theme/cte/image-field-editor";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import type { CteSelection } from "@/lib/cte";
import { listProducts, type Product } from "@/lib/products";
import type {
  ButtonBlock as ButtonBlockValue,
  ContainerBlock as ContainerBlockValue,
  ImageBlock as ImageBlockValue,
  ProductCardBlock as ProductCardBlockValue,
  ProductListBlock as ProductListBlockValue,
  RichText,
  TextContentBlock as TextContentBlockValue,
  ThemeCta,
  ThemeImage,
} from "@/lib/theme";

type FeatureItemValue = { title: string; description: string; image?: ThemeImage };
type CtaValue = ThemeCta;

const UNSET = "__unset__";

/** A single-product `<Select>`, shared by block-product-card, block-button
 * (add_to_cart's product) and block-container (link_product_id) — 2026-08-20.
 * `products: null` means "still loading" (see the catalog-fetch effect
 * below); an owner's own admin-authed catalog (`listProducts`, not the
 * public storefront read) since this whole popover only ever renders on
 * the admin/owner-gated `/editor` page. */
function ProductSelect({
  label,
  products,
  value,
  onChange,
  allowNone,
}: {
  label: string;
  products: Product[] | null;
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  allowNone?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select
        value={value != null ? String(value) : UNSET}
        onValueChange={(next) => onChange(next === UNSET ? null : Number(next))}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={products === null ? "Loading…" : "Pick a product"} />
        </SelectTrigger>
        <SelectContent>
          {allowNone || products === null || products.length === 0 ? (
            <SelectItem value={UNSET}>None</SelectItem>
          ) : null}
          {(products ?? []).map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.name} (${p.price.toFixed(2)})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A scrollable checklist for ProductListBlock's `product_ids` allow-list
 * (2026-08-20) — a `<Select>` only carries one value, so a multi-pick
 * filter needs a different control; `Switch` rows match this project's
 * existing "Switch instead of a separate Checkbox primitive" convention
 * (see IntentSchemaPanel). */
function ProductChecklist({
  products,
  selected,
  onToggle,
}: {
  products: Product[] | null;
  selected: number[];
  onToggle: (id: number, checked: boolean) => void;
}) {
  if (products === null) return <LoadingSpinner label="Loading products…" />;
  if (products.length === 0) {
    return <p className="text-xs text-muted-foreground">No products in your catalog yet.</p>;
  }
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
      {products.map((p) => (
        <div key={p.id} className="flex items-center justify-between gap-2 py-1">
          <span className="text-sm">{p.name}</span>
          <Switch checked={selected.includes(p.id)} onCheckedChange={(checked) => onToggle(p.id, checked)} />
        </div>
      ))}
    </div>
  );
}

/** A labeled dropdown over a small fixed set of options, with an optional
 * "Default" entry that clears the field back to `undefined` — the same
 * controlled-enum pattern every style field in this schema already uses,
 * just with a real editing UI now instead of only being set by the
 * vision LLM. Generic over the option value type so one component covers
 * every enum field below (layout, gap, padding, size, weight, ...)
 * instead of a bespoke `<Select>` per field. */
function EnumField<T extends string>({
  label,
  value,
  options,
  onChange,
  allowUnset,
}: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
  allowUnset?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select
        value={value ?? UNSET}
        onValueChange={(next) => onChange(next === UNSET ? undefined : (next as T))}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowUnset ? <SelectItem value={UNSET}>Default</SelectItem> : null}
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A bounded numeric input with a "Default" reset — added 2026-08-06 for
 * `RichText.size` specifically, after real testing showed a fixed enum
 * (like `EnumField` above renders) can't cover a headline's realistic
 * size range — see `RichText`'s doc comment in `lib/theme.ts`. `min`/
 * `max` keep this a bounded, controlled number rather than open-ended
 * free-form styling; an out-of-range typed value is clamped on blur, not
 * silently accepted. */
function NumberField({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label} ({unit})
      </label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={min}
          max={max}
          value={value ?? ""}
          placeholder="Default"
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? undefined : Number(raw));
          }}
          onBlur={(event) => {
            const raw = event.target.value;
            if (raw === "") return;
            const clamped = Math.min(max, Math.max(min, Number(raw)));
            onChange(clamped);
          }}
          className="w-24"
        />
        {value !== undefined ? (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Reset to default
          </button>
        ) : null}
      </div>
    </div>
  );
}

const LAYOUT_OPTIONS = [
  { value: "row" as const, label: "Row (side by side)" },
  { value: "column" as const, label: "Column (stacked)" },
  { value: "grid" as const, label: "Grid" },
];
const JUSTIFY_OPTIONS = [
  { value: "start" as const, label: "Start" },
  { value: "center" as const, label: "Center" },
  { value: "end" as const, label: "End" },
  { value: "between" as const, label: "Space between" },
];
const ALIGN_OPTIONS = [
  { value: "start" as const, label: "Start" },
  { value: "center" as const, label: "Center" },
  { value: "end" as const, label: "End" },
  { value: "stretch" as const, label: "Stretch" },
];
const SPACING_OPTIONS = [
  { value: "none" as const, label: "None" },
  { value: "sm" as const, label: "Small" },
  { value: "md" as const, label: "Medium" },
  { value: "lg" as const, label: "Large" },
];
const MIN_HEIGHT_OPTIONS = [
  { value: "sm" as const, label: "Small" },
  { value: "md" as const, label: "Medium" },
  { value: "lg" as const, label: "Large" },
  { value: "xl" as const, label: "Extra large" },
  { value: "screen" as const, label: "Full screen" },
];
// RichText.size's numeric bounds (px) — see NumberField's doc comment.
// 12px covers fine print; 96px comfortably exceeds every fixed heading
// size already used across the theme (Hero's own default tops out at
// text-5xl/48px, feature-grid headings smaller still), so a real display-
// scale headline is reachable without allowing an unbounded value.
const RT_SIZE_MIN = 12;
const RT_SIZE_MAX = 96;

// TextContentBlock's own `size` field — a Block primitive, not a
// headline — stays the original small fixed enum; only RichText's size
// switched to numeric input (NumberField above).
const TEXT_SIZE_OPTIONS = [
  { value: "sm" as const, label: "Small" },
  { value: "base" as const, label: "Base" },
  { value: "lg" as const, label: "Large" },
  { value: "xl" as const, label: "XL" },
  { value: "2xl" as const, label: "2XL" },
  { value: "3xl" as const, label: "3XL" },
];
const WEIGHT_OPTIONS = [
  { value: "normal" as const, label: "Normal" },
  { value: "medium" as const, label: "Medium" },
  { value: "semibold" as const, label: "Semibold" },
  { value: "bold" as const, label: "Bold" },
];
const TEXT_ALIGN_OPTIONS = [
  { value: "left" as const, label: "Left" },
  { value: "center" as const, label: "Center" },
  { value: "right" as const, label: "Right" },
];
const ASPECT_OPTIONS = [
  { value: "square" as const, label: "Square" },
  { value: "video" as const, label: "Video (16:9)" },
  { value: "portrait" as const, label: "Portrait" },
  { value: "auto" as const, label: "Auto" },
];
const ROUNDED_OPTIONS = [
  { value: "none" as const, label: "None" },
  { value: "sm" as const, label: "Small" },
  { value: "lg" as const, label: "Large" },
  { value: "full" as const, label: "Full" },
];
const BUTTON_ROUNDED_OPTIONS = ROUNDED_OPTIONS;
const BUTTON_SIZE_OPTIONS = [
  { value: "sm" as const, label: "Small" },
  { value: "default" as const, label: "Default" },
  { value: "lg" as const, label: "Large" },
];
const BORDER_WIDTH_OPTIONS = [
  { value: "thin" as const, label: "Thin" },
  { value: "thick" as const, label: "Thick" },
];
// ProductListBlock's filter mode (2026-08-20) — not a schema field itself,
// just this popover's own UI state for choosing which of category/
// product_ids (mutually exclusive on the wire, see lib/theme.ts) is active.
const PRODUCT_FILTER_OPTIONS = [
  { value: "all" as const, label: "Every available product" },
  { value: "category" as const, label: "One category" },
  { value: "ids" as const, label: "Specific products" },
];
const BUTTON_ACTION_OPTIONS = [
  { value: "link" as const, label: "Link to a page" },
  { value: "add_to_cart" as const, label: "Add a product to cart" },
];

type CteEditorPopoverProps = {
  selection: CteSelection;
  onSave: (value: unknown) => void;
  onCancel: () => void;
  /** Present only for existing (non-"create") feature-item/cta selections
   * — see AddItemButton/CteEditorPanel. Renders a Delete button when set. */
  onDelete?: () => void;
};

/** The field editor, opened by clicking an Editable badge.
 *
 * **2026-08-04 redesign, replacing a `position: fixed` popover positioned
 * next to the click** (via `getBoundingClientRect()`): that approach had
 * a real bug — clamping math aside, a block near the bottom of a long
 * page could still push the popover partly or fully off-screen, and
 * because it was `position: fixed`, scrolling afterward didn't bring it
 * back into view (fixed elements track the viewport, not the page, so
 * there was nothing to scroll *to*). A `Sheet` (shadcn, base-ui Dialog
 * underneath — already used by MobileNav) sidesteps the whole problem:
 * it always renders at a fixed screen edge regardless of where the
 * clicked element was, which also happens to make room for a real form
 * (image field now has 4 tabs — see ImageFieldEditor) instead of a
 * cramped 320px box. Component filename kept as-is (cte-editor-popover)
 * despite no longer being a popover, to avoid a needless rename churn on
 * top of the redesign.
 *
 * **2026-08-06 — block-* fieldTypes added.** These edit a whole
 * Container/Text/Image/Button Block instance (see lib/theme.ts's `Block`
 * union): content AND style (color, size/weight, padding/margin,
 * layout/justify/align) in one form, since a Block's style knobs live on
 * the same object as its content — unlike the fixed composite sections'
 * fieldTypes above, which only ever edit a plain string/CTA/item. Every
 * style control here is still a constrained enum or a plain hex color
 * (via ColorField) — no free-form CSS, same principle the schema has held
 * throughout. Deliberately NOT included in this pass: editing `width`
 * (BlockWidth, only meaningful as a row child) and inserting/removing
 * blocks from a container's `children` — both left for a later increment. */
export function CteEditorPopover({ selection, onSave, onCancel, onDelete }: CteEditorPopoverProps) {
  const { fieldType, value, mode = "edit" } = selection;

  const [text, setText] = React.useState(typeof value === "string" ? value : "");
  const [imageDraft, setImageDraft] = React.useState<ThemeImage>(
    fieldType === "image" ? ((value as ThemeImage | undefined) ?? { url: "#", alt: "" }) : { url: "#", alt: "" },
  );
  const [itemTitle, setItemTitle] = React.useState(
    fieldType === "feature-item" ? ((value as FeatureItemValue).title ?? "") : "",
  );
  const [itemDescription, setItemDescription] = React.useState(
    fieldType === "feature-item" ? ((value as FeatureItemValue).description ?? "") : "",
  );
  const [itemImageDraft, setItemImageDraft] = React.useState<ThemeImage>(
    fieldType === "feature-item" ? ((value as FeatureItemValue).image ?? { url: "#", alt: "" }) : { url: "#", alt: "" },
  );
  const [badges, setBadges] = React.useState(
    fieldType === "badge-list" && Array.isArray(value) ? (value as string[]).join(", ") : "",
  );
  const [ctaLabel, setCtaLabel] = React.useState(fieldType === "cta" ? ((value as CtaValue).label ?? "") : "");
  const [ctaHref, setCtaHref] = React.useState(fieldType === "cta" ? ((value as CtaValue).href ?? "") : "");
  const [ctaBackgroundColor, setCtaBackgroundColor] = React.useState(
    fieldType === "cta" ? (value as CtaValue).background_color : undefined,
  );
  const [ctaTextColor, setCtaTextColor] = React.useState(
    fieldType === "cta" ? (value as CtaValue).text_color : undefined,
  );
  const [ctaBorderColor, setCtaBorderColor] = React.useState(
    fieldType === "cta" ? (value as CtaValue).border_color : undefined,
  );
  const [ctaRounded, setCtaRounded] = React.useState(fieldType === "cta" ? (value as CtaValue).rounded : undefined);
  const [ctaSize, setCtaSize] = React.useState(fieldType === "cta" ? (value as CtaValue).size : undefined);
  const [ctaBorderWidth, setCtaBorderWidth] = React.useState(
    fieldType === "cta" ? (value as CtaValue).border_width : undefined,
  );

  // rich-text draft — headline/heading/subheading/body fields across the
  // fixed composite sections (Hero, FeatureGrid, TextBlock, CtaBanner,
  // BadgeList). Content-only "text" fieldType (eyebrow, etc.) stays a
  // separate, simpler form above — it was never widened to accept style,
  // so showing style controls there would let an edit save a value its
  // own field's type can't actually hold.
  //
  // Seeded from `selection.computedDefaults` (the field's real rendered
  // size/weight/color, read off the DOM — see Editable's
  // readComputedRichTextDefaults) whenever there's no explicit override
  // already stored, added 2026-08-06 at the user's request: this field's
  // "unset" state has no one universal default the way most other style
  // fields do (a `ContainerBlock.layout` field always defaults to "row"
  // regardless of context; a Hero headline and a badge-list heading
  // render at completely different sizes), so showing a blank "Default"
  // input here was showing nothing useful. Saving without touching these
  // pins them at the value already shown — harmless, since it's exactly
  // what's already rendering.
  const richTextValue = fieldType === "rich-text" ? (value as RichText) : null;
  const computedDefaults = fieldType === "rich-text" ? selection.computedDefaults : undefined;
  const [rtContent, setRtContent] = React.useState(richTextValue?.content ?? "");
  const [rtSize, setRtSize] = React.useState(richTextValue?.size ?? computedDefaults?.size);
  const [rtWeight, setRtWeight] = React.useState(richTextValue?.weight ?? computedDefaults?.weight);
  const [rtColor, setRtColor] = React.useState(richTextValue?.color ?? computedDefaults?.color);

  // block-container draft
  const containerValue = fieldType === "block-container" ? (value as ContainerBlockValue) : null;
  const [cLayout, setCLayout] = React.useState(containerValue?.layout ?? "row");
  const [cJustify, setCJustify] = React.useState(containerValue?.justify);
  const [cAlign, setCAlign] = React.useState(containerValue?.align ?? "stretch");
  const [cGap, setCGap] = React.useState(containerValue?.gap ?? "md");
  const [cPadding, setCPadding] = React.useState(containerValue?.padding ?? "none");
  const [cMargin, setCMargin] = React.useState(containerValue?.margin ?? "none");
  const [cMinHeight, setCMinHeight] = React.useState(containerValue?.min_height);
  const [cFullBleed, setCFullBleed] = React.useState(containerValue?.full_bleed ?? false);
  const [cBackgroundColor, setCBackgroundColor] = React.useState(containerValue?.background_color);
  const [cBorderColor, setCBorderColor] = React.useState(containerValue?.border_color);
  const [cBackgroundImage, setCBackgroundImage] = React.useState<ThemeImage | undefined>(
    containerValue?.background_image,
  );
  // Added 2026-08-20 — see lib/theme.ts's ContainerBlock.link_product_id
  // doc comment for the "owner-composed product promo block" design.
  const [cLinkProductId, setCLinkProductId] = React.useState<number | null>(
    containerValue?.link_product_id ?? null,
  );

  // block-text draft
  const textBlockValue = fieldType === "block-text" ? (value as TextContentBlockValue) : null;
  const [tContent, setTContent] = React.useState(textBlockValue?.content ?? "");
  const [tSize, setTSize] = React.useState(textBlockValue?.size ?? "base");
  const [tWeight, setTWeight] = React.useState(textBlockValue?.weight ?? "normal");
  const [tAlign, setTAlign] = React.useState(textBlockValue?.align ?? "left");
  const [tColor, setTColor] = React.useState(textBlockValue?.color);

  // block-image draft
  const imageBlockValue = fieldType === "block-image" ? (value as ImageBlockValue) : null;
  const [biImage, setBiImage] = React.useState<ThemeImage>(imageBlockValue?.image ?? { url: "#", alt: "" });
  const [biAspect, setBiAspect] = React.useState(imageBlockValue?.aspect_ratio ?? "auto");
  const [biRounded, setBiRounded] = React.useState(imageBlockValue?.rounded ?? "lg");

  // block-button draft
  const buttonBlockValue = fieldType === "block-button" ? (value as ButtonBlockValue) : null;
  const [bbLabel, setBbLabel] = React.useState(buttonBlockValue?.label ?? "");
  const [bbHref, setBbHref] = React.useState(buttonBlockValue?.href ?? "");
  const [bbBackgroundColor, setBbBackgroundColor] = React.useState(buttonBlockValue?.background_color);
  const [bbTextColor, setBbTextColor] = React.useState(buttonBlockValue?.text_color);
  const [bbBorderColor, setBbBorderColor] = React.useState(buttonBlockValue?.border_color);
  const [bbRounded, setBbRounded] = React.useState(buttonBlockValue?.rounded);
  const [bbSize, setBbSize] = React.useState(buttonBlockValue?.size ?? "lg");
  const [bbBorderWidth, setBbBorderWidth] = React.useState(buttonBlockValue?.border_width);
  // Added 2026-08-20 — see lib/theme.ts's ButtonBlock.action doc comment.
  const [bbAction, setBbAction] = React.useState(buttonBlockValue?.action ?? "link");
  const [bbProductId, setBbProductId] = React.useState<number | null>(buttonBlockValue?.product_id ?? null);

  // block-product-list draft (2026-08-20) — `plFilterMode` is this
  // popover's own UI state, not a schema field: category/product_ids are
  // mutually exclusive on the wire (see lib/theme.ts), so the form only
  // ever writes one of them back, derived from whichever the stored value
  // already had set.
  const productListValue = fieldType === "block-product-list" ? (value as ProductListBlockValue) : null;
  const [plFilterMode, setPlFilterMode] = React.useState<"all" | "category" | "ids">(
    productListValue?.product_ids && productListValue.product_ids.length > 0
      ? "ids"
      : productListValue?.category
        ? "category"
        : "all",
  );
  const [plCategory, setPlCategory] = React.useState(productListValue?.category ?? "");
  const [plProductIds, setPlProductIds] = React.useState<number[]>(productListValue?.product_ids ?? []);

  // block-product-card draft (2026-08-20)
  const productCardValue = fieldType === "block-product-card" ? (value as ProductCardBlockValue) : null;
  const [pcProductId, setPcProductId] = React.useState<number | null>(productCardValue?.product_id ?? null);

  // Shared product catalog, fetched once for every fieldType with a
  // product picker (block-product-list, block-product-card,
  // block-container's link picker, block-button's add-to-cart picker) —
  // one fetch regardless of how many of this popover's own controls need
  // it. Admin-authed (lib/products.ts's listProducts, not the public
  // storefront read) since this whole popover only ever renders on the
  // admin/owner-gated /editor page.
  const needsCatalog =
    fieldType === "block-product-list" ||
    fieldType === "block-product-card" ||
    fieldType === "block-container" ||
    fieldType === "block-button";
  const [catalog, setCatalog] = React.useState<Product[] | null>(null);
  React.useEffect(() => {
    if (!needsCatalog || catalog !== null) return;
    listProducts()
      .then(setCatalog)
      .catch(() => setCatalog([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsCatalog]);

  // Pure — computes "the value this fieldType's form currently represents"
  // without calling onSave itself, so both the live-update effect (edit
  // mode) and the explicit Add button (create mode, see below) can share
  // one calculation instead of two copies drifting apart.
  function computeValue(): unknown {
    if (fieldType === "text") {
      return text;
    } else if (fieldType === "image") {
      return imageDraft;
    } else if (fieldType === "feature-item") {
      const original = value as FeatureItemValue;
      return {
        ...original,
        title: itemTitle,
        description: itemDescription,
        image: original.image ? itemImageDraft : undefined,
      } satisfies FeatureItemValue;
    } else if (fieldType === "badge-list") {
      return badges
        .split(",")
        .map((badge) => badge.trim())
        .filter(Boolean);
    } else if (fieldType === "cta") {
      return {
        ...(value as CtaValue),
        label: ctaLabel,
        href: ctaHref,
        background_color: ctaBackgroundColor,
        text_color: ctaTextColor,
        border_color: ctaBorderColor,
        rounded: ctaRounded,
        size: ctaSize,
        border_width: ctaBorderWidth,
      } satisfies CtaValue;
    } else if (fieldType === "rich-text") {
      // Plain string when no style override is set — keeps the common
      // case (just editing the words) producing exactly the same shape
      // this field held before RichText existed, not an object for no
      // reason.
      const hasStyle = Boolean(rtColor) || Boolean(rtSize) || Boolean(rtWeight);
      return hasStyle ? ({ content: rtContent, color: rtColor, size: rtSize, weight: rtWeight } satisfies RichText) : rtContent;
    } else if (fieldType === "block-container" && containerValue) {
      return {
        ...containerValue,
        layout: cLayout,
        justify: cJustify,
        align: cAlign,
        gap: cGap,
        padding: cPadding,
        margin: cMargin,
        min_height: cMinHeight,
        full_bleed: cFullBleed,
        background_color: cBackgroundColor,
        border_color: cBorderColor,
        background_image: cBackgroundImage,
        link_product_id: cLinkProductId,
      } satisfies ContainerBlockValue;
    } else if (fieldType === "block-text" && textBlockValue) {
      return {
        ...textBlockValue,
        content: tContent,
        size: tSize,
        weight: tWeight,
        align: tAlign,
        color: tColor,
      } satisfies TextContentBlockValue;
    } else if (fieldType === "block-image" && imageBlockValue) {
      return {
        ...imageBlockValue,
        image: biImage,
        aspect_ratio: biAspect,
        rounded: biRounded,
      } satisfies ImageBlockValue;
    } else if (fieldType === "block-button" && buttonBlockValue) {
      return {
        ...buttonBlockValue,
        label: bbLabel,
        href: bbHref,
        background_color: bbBackgroundColor,
        text_color: bbTextColor,
        border_color: bbBorderColor,
        rounded: bbRounded,
        size: bbSize,
        border_width: bbBorderWidth,
        action: bbAction,
        product_id: bbProductId,
      } satisfies ButtonBlockValue;
    } else if (fieldType === "block-product-list" && productListValue) {
      return {
        ...productListValue,
        category: plFilterMode === "category" ? plCategory || null : null,
        product_ids: plFilterMode === "ids" ? plProductIds : null,
      } satisfies ProductListBlockValue;
    } else if (fieldType === "block-product-card" && productCardValue) {
      return { ...productCardValue, product_id: pcProductId } satisfies ProductCardBlockValue;
    }
    return undefined;
  }

  // Live-apply every change in "edit" mode — added 2026-08-06 at the
  // user's direct request: adjusting a color/size/etc should update the
  // page behind this panel immediately, not require a separate Save
  // click just to see whether it looks right. "create" mode (AddItemButton)
  // deliberately stays explicit-Add-only: onSave there means "append a new
  // element," and appending on every keystroke while filling out a new
  // item would append a fresh element each time instead of refining one.
  // `skipFirstRun` swallows the effect's unavoidable mount-time firing —
  // without it, merely opening an editor (no actual change yet) would
  // still mark the page dirty.
  const isLive = mode === "edit";
  const skipFirstRun = React.useRef(true);
  React.useEffect(() => {
    if (!isLive) return;
    if (skipFirstRun.current) {
      skipFirstRun.current = false;
      return;
    }
    onSave(computeValue());
    // Deliberately broad deps: every draft value across every fieldType's
    // form, so any field's change re-applies the live value. Safe as an
    // effect (not a plain call in the render body) specifically because
    // it's gated on `isLive` and gated on skipping its first run — see
    // above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isLive,
    text,
    imageDraft,
    itemTitle,
    itemDescription,
    itemImageDraft,
    badges,
    ctaLabel,
    ctaHref,
    ctaBackgroundColor,
    ctaTextColor,
    ctaBorderColor,
    ctaRounded,
    ctaSize,
    ctaBorderWidth,
    rtContent,
    rtSize,
    rtWeight,
    rtColor,
    cLayout,
    cJustify,
    cAlign,
    cGap,
    cPadding,
    cMargin,
    cMinHeight,
    cFullBleed,
    cBackgroundColor,
    cBorderColor,
    cBackgroundImage,
    cLinkProductId,
    tContent,
    tSize,
    tWeight,
    tAlign,
    tColor,
    biImage,
    biAspect,
    biRounded,
    bbLabel,
    bbHref,
    bbBackgroundColor,
    bbTextColor,
    bbBorderColor,
    bbRounded,
    bbSize,
    bbBorderWidth,
    bbAction,
    bbProductId,
    plFilterMode,
    plCategory,
    plProductIds,
    pcProductId,
  ]);

  // "create" mode's explicit Add button — the one case that still needs a
  // deliberate, single commit rather than living updates (see above).
  function handleAdd() {
    onSave(computeValue());
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <SheetContent side="right" showOverlay={false}>
        <SheetHeader>
          <SheetTitle>{mode === "create" ? "Add content" : "Edit content"}</SheetTitle>
          {isLive ? (
            <p className="text-xs text-muted-foreground">Changes apply immediately — no separate save needed here.</p>
          ) : null}
        </SheetHeader>

        <div className="flex-1 space-y-3 overflow-y-auto px-4">
          {fieldType === "text" ? (
            <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={5} autoFocus />
          ) : null}

          {fieldType === "image" ? <ImageFieldEditor value={imageDraft} onChange={setImageDraft} /> : null}

          {fieldType === "feature-item" ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <Input value={itemTitle} onChange={(event) => setItemTitle(event.target.value)} autoFocus />
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Textarea
                value={itemDescription}
                onChange={(event) => setItemDescription(event.target.value)}
                rows={3}
              />
              {(value as FeatureItemValue).image ? (
                <>
                  <label className="text-xs font-medium text-muted-foreground">Image</label>
                  <ImageFieldEditor value={itemImageDraft} onChange={setItemImageDraft} />
                </>
              ) : null}
            </div>
          ) : null}

          {fieldType === "badge-list" ? (
            <Textarea
              value={badges}
              onChange={(event) => setBadges(event.target.value)}
              placeholder="Comma-separated badges"
              rows={3}
              autoFocus
            />
          ) : null}

          {fieldType === "cta" ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Button label</label>
                <Input value={ctaLabel} onChange={(event) => setCtaLabel(event.target.value)} autoFocus />
                <label className="text-xs font-medium text-muted-foreground">Link (href)</label>
                <Input value={ctaHref} onChange={(event) => setCtaHref(event.target.value)} placeholder="/chat" />
              </div>
              <ColorField label="Background color" value={ctaBackgroundColor} onChange={setCtaBackgroundColor} />
              <ColorField label="Text color" value={ctaTextColor} onChange={setCtaTextColor} />
              <ColorField label="Border color" value={ctaBorderColor} onChange={setCtaBorderColor} />
              <EnumField label="Border width" value={ctaBorderWidth} options={BORDER_WIDTH_OPTIONS} onChange={setCtaBorderWidth} allowUnset />
              <EnumField label="Rounded corners" value={ctaRounded} options={BUTTON_ROUNDED_OPTIONS} onChange={setCtaRounded} allowUnset />
              <EnumField label="Size" value={ctaSize} options={BUTTON_SIZE_OPTIONS} onChange={setCtaSize} allowUnset />
            </div>
          ) : null}

          {fieldType === "rich-text" ? (
            <div className="space-y-3">
              <Textarea value={rtContent} onChange={(event) => setRtContent(event.target.value)} rows={4} autoFocus />
              <NumberField label="Size" value={rtSize} min={RT_SIZE_MIN} max={RT_SIZE_MAX} unit="px" onChange={setRtSize} />
              <EnumField label="Weight" value={rtWeight} options={WEIGHT_OPTIONS} onChange={setRtWeight} allowUnset />
              <ColorField label="Text color" value={rtColor} onChange={setRtColor} />
            </div>
          ) : null}

          {fieldType === "block-container" ? (
            <div className="space-y-3">
              <EnumField label="Layout" value={cLayout} options={LAYOUT_OPTIONS} onChange={(v) => v && setCLayout(v)} />
              {cLayout !== "grid" ? (
                <>
                  <EnumField
                    label="Justify (main axis — left/right for a row, top/bottom for a column)"
                    value={cJustify}
                    options={JUSTIFY_OPTIONS}
                    onChange={setCJustify}
                    allowUnset
                  />
                  <EnumField
                    label="Align (cross axis)"
                    value={cAlign}
                    options={ALIGN_OPTIONS}
                    onChange={(v) => v && setCAlign(v)}
                  />
                </>
              ) : null}
              <EnumField label="Gap" value={cGap} options={SPACING_OPTIONS} onChange={(v) => v && setCGap(v)} />
              <EnumField
                label="Padding (inside the border)"
                value={cPadding}
                options={SPACING_OPTIONS}
                onChange={(v) => v && setCPadding(v)}
              />
              <EnumField
                label="Margin (outside the border)"
                value={cMargin}
                options={SPACING_OPTIONS}
                onChange={(v) => v && setCMargin(v)}
              />
              <EnumField
                label="Minimum height"
                value={cMinHeight}
                options={MIN_HEIGHT_OPTIONS}
                onChange={setCMinHeight}
                allowUnset
              />
              <div className="flex items-center justify-between rounded-lg border p-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="cte-full-bleed">
                  Full width (edge to edge)
                </label>
                <Switch id="cte-full-bleed" checked={cFullBleed} onCheckedChange={setCFullBleed} />
              </div>
              <ColorField label="Background color" value={cBackgroundColor} onChange={setCBackgroundColor} />
              <ColorField label="Border color" value={cBorderColor} onChange={setCBorderColor} />
              <ProductSelect
                label="Link this whole block to a product (optional)"
                products={catalog}
                value={cLinkProductId}
                onChange={setCLinkProductId}
                allowNone
              />
              {cBackgroundImage ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Background image</label>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setCBackgroundImage(undefined)}>
                      Remove
                    </Button>
                  </div>
                  <ImageFieldEditor value={cBackgroundImage} onChange={setCBackgroundImage} />
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCBackgroundImage({ url: "#", alt: "" })}
                >
                  Add background image
                </Button>
              )}
            </div>
          ) : null}

          {fieldType === "block-text" ? (
            <div className="space-y-3">
              <Textarea value={tContent} onChange={(event) => setTContent(event.target.value)} rows={4} autoFocus />
              <EnumField label="Size" value={tSize} options={TEXT_SIZE_OPTIONS} onChange={(v) => v && setTSize(v)} />
              <EnumField label="Weight" value={tWeight} options={WEIGHT_OPTIONS} onChange={(v) => v && setTWeight(v)} />
              <EnumField
                label="Align"
                value={tAlign}
                options={TEXT_ALIGN_OPTIONS}
                onChange={(v) => v && setTAlign(v)}
              />
              <ColorField label="Text color" value={tColor} onChange={setTColor} />
            </div>
          ) : null}

          {fieldType === "block-image" ? (
            <div className="space-y-3">
              <ImageFieldEditor value={biImage} onChange={setBiImage} />
              <EnumField
                label="Aspect ratio"
                value={biAspect}
                options={ASPECT_OPTIONS}
                onChange={(v) => v && setBiAspect(v)}
              />
              <EnumField
                label="Rounded corners"
                value={biRounded}
                options={ROUNDED_OPTIONS}
                onChange={(v) => v && setBiRounded(v)}
              />
            </div>
          ) : null}

          {fieldType === "block-button" ? (
            <div className="space-y-3">
              <label className="text-xs font-medium text-muted-foreground">Button label</label>
              <Input value={bbLabel} onChange={(event) => setBbLabel(event.target.value)} autoFocus />
              <EnumField label="Action" value={bbAction} options={BUTTON_ACTION_OPTIONS} onChange={(v) => v && setBbAction(v)} />
              {bbAction === "add_to_cart" ? (
                <ProductSelect label="Product to add" products={catalog} value={bbProductId} onChange={setBbProductId} />
              ) : (
                <>
                  <label className="text-xs font-medium text-muted-foreground">Link (href)</label>
                  <Input value={bbHref} onChange={(event) => setBbHref(event.target.value)} placeholder="/chat" />
                </>
              )}
              <ColorField label="Background color" value={bbBackgroundColor} onChange={setBbBackgroundColor} />
              <ColorField label="Text color" value={bbTextColor} onChange={setBbTextColor} />
              <ColorField label="Border color" value={bbBorderColor} onChange={setBbBorderColor} />
              <EnumField label="Border width" value={bbBorderWidth} options={BORDER_WIDTH_OPTIONS} onChange={setBbBorderWidth} allowUnset />
              <EnumField label="Rounded corners" value={bbRounded} options={BUTTON_ROUNDED_OPTIONS} onChange={setBbRounded} allowUnset />
              <EnumField label="Size" value={bbSize} options={BUTTON_SIZE_OPTIONS} onChange={(v) => v && setBbSize(v)} />
            </div>
          ) : null}

          {fieldType === "block-product-list" ? (
            <div className="space-y-3">
              <EnumField
                label="Which products to show"
                value={plFilterMode}
                options={PRODUCT_FILTER_OPTIONS}
                onChange={(v) => v && setPlFilterMode(v)}
              />
              {plFilterMode === "category" ? (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Category</label>
                  <Input
                    value={plCategory}
                    onChange={(event) => setPlCategory(event.target.value)}
                    placeholder="e.g. Coffee"
                    autoFocus
                  />
                </div>
              ) : null}
              {plFilterMode === "ids" ? (
                <ProductChecklist
                  products={catalog}
                  selected={plProductIds}
                  onToggle={(id, checked) =>
                    setPlProductIds((prev) => (checked ? [...prev, id] : prev.filter((existing) => existing !== id)))
                  }
                />
              ) : null}
            </div>
          ) : null}

          {fieldType === "block-product-card" ? (
            <ProductSelect label="Product" products={catalog} value={pcProductId} onChange={setPcProductId} />
          ) : null}
        </div>

        <SheetFooter className="flex-row items-center justify-between gap-2">
          {onDelete ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (window.confirm("Remove this item? This can't be undone until you save a new version anyway.")) {
                  onDelete();
                }
              }}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {isLive ? (
              // No Cancel/Save here — every change already applied live
              // (see the effect above), so "closing" and "committing" are
              // the same action now. The panel-level "Save as new version"
              // / "Reload (discard edits)" buttons in CteEditorPanel are
              // still the real undo point for everything since the last
              // backend save.
              <Button size="sm" onClick={onCancel}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={onCancel}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleAdd}>
                  Add
                </Button>
              </>
            )}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
