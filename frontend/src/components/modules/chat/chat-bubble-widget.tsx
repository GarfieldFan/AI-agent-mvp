"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { MessageCircle, X } from "lucide-react";

import { ChatPanel } from "@/components/modules/chat/chat-panel";
import { cn } from "@/lib/utils";

// Hidden on routes where it would be redundant or would visually collide
// with something else already occupying the bottom-right corner:
// `/chat` already IS the full chatbot page (a second copy floating on
// top of itself would be confusing, not helpful); `/editor`'s CTE Sheets
// (block-insert-menu.tsx, section-insert-menu.tsx, cte-editor-popover.tsx)
// all render `side="right"` — `inset-y-0 right-0`, spanning the exact
// corner this widget docks in — so the two would physically overlap.
const HIDDEN_ROUTES = ["/chat", "/editor"];

/** A site-wide floating chat entry point — mounted once in the root
 * layout (`app/layout.tsx`) so it's available on every page, not just
 * `/chat`. Deliberately a toggle button (bubble ↔ close X) with the
 * panel positioned as a sibling above it, not a Dialog/Sheet — this
 * needs to coexist with normal page scrolling and any other overlay
 * already on screen, not take one over.
 *
 * **Panel stays mounted while "closed"** (hidden via opacity/pointer-
 * events, not conditional rendering) specifically so `ChatPanel`'s own
 * message-history state survives closing and reopening the bubble — and,
 * since `app/layout.tsx` doesn't remount across client-side navigation in
 * the App Router, survives navigating to a different page while the
 * widget is docked, too. Only a full page reload resets the
 * conversation, matching how a real chat widget behaves. */
export function ChatBubbleWidget() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  if (HIDDEN_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return null;
  }

  return (
    <>
      <div
        className={cn(
          "fixed right-6 bottom-24 z-40 flex w-[380px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border bg-background shadow-xl transition motion-reduce:transition-none",
          open ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
          <p className="text-sm font-medium">Chat with us</p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close chat"
            tabIndex={open ? 0 : -1}
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <ChatPanel embedded />
      </div>

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={open ? "Close chat" : "Open chat"}
        aria-expanded={open}
        className="fixed right-6 bottom-6 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:brightness-110"
      >
        {open ? <X className="size-6" /> : <MessageCircle className="size-6" />}
      </button>
    </>
  );
}
