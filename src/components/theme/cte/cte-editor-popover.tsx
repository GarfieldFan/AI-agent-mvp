"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ImageFieldEditor } from "@/components/theme/cte/image-field-editor";
import type { CteSelection } from "@/lib/cte";
import type { ThemeCta, ThemeImage } from "@/lib/theme";

type FeatureItemValue = { title: string; description: string; image?: ThemeImage };
type CtaValue = ThemeCta;

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
 * top of the redesign. */
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

  function handleSave() {
    if (fieldType === "text") {
      onSave(text);
    } else if (fieldType === "image") {
      onSave(imageDraft);
    } else if (fieldType === "feature-item") {
      const original = value as FeatureItemValue;
      onSave({
        ...original,
        title: itemTitle,
        description: itemDescription,
        image: original.image ? itemImageDraft : undefined,
      } satisfies FeatureItemValue);
    } else if (fieldType === "badge-list") {
      onSave(
        badges
          .split(",")
          .map((badge) => badge.trim())
          .filter(Boolean),
      );
    } else if (fieldType === "cta") {
      onSave({ ...(value as CtaValue), label: ctaLabel, href: ctaHref } satisfies CtaValue);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{mode === "create" ? "Add content" : "Edit content"}</SheetTitle>
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
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Button label</label>
              <Input value={ctaLabel} onChange={(event) => setCtaLabel(event.target.value)} autoFocus />
              <label className="text-xs font-medium text-muted-foreground">Link (href)</label>
              <Input value={ctaHref} onChange={(event) => setCtaHref(event.target.value)} placeholder="/chat" />
            </div>
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
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave}>
              {mode === "create" ? "Add" : "Save"}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
