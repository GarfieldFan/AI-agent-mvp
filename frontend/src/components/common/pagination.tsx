"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Shared Prev/Next page-number control (2026-08-20) — reused across
 * `ProductPanel`, `OrderPanel`, `ReviewQueuePanel` (per-queue), and
 * `/search`, all of which moved from "fetch everything, render it all"
 * to real server-side pagination the same session (see the root
 * `AGENTS.md`). Deliberately just Prev/Next + "Page X of Y", not a
 * numbered page-button strip — this app's realistic list sizes don't
 * need jump-to-page navigation, and it's the same control shape
 * regardless of how many total pages exist.
 *
 * `page` is 1-indexed (matches how a human reads "page 1 of 3", and how
 * `/search`'s own `?page=` URL param reads). Renders nothing when
 * `total <= pageSize` — a list that already fits on one page has
 * nothing to paginate. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  disabled = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;

  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        Showing {rangeStart}–{rangeEnd} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Previous page"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="w-16 text-center">
          Page {page} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Next page"
          disabled={disabled || page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
