"use client";

import * as React from "react";
import Link from "next/link";
import { ShoppingCart } from "lucide-react";
import type { CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { Editable } from "@/components/theme/cte/editable";
import { themeButtonClassName } from "@/components/theme/theme-cta-style";
import { addToCart } from "@/lib/cart";
import type { ButtonBlock as ButtonBlockData } from "@/lib/theme";

/** A button with AI/CTE-controlled colors instead of the fixed variant
 * palette ThemeCta's buttons use — `background_color`/`text_color`/
 * `border_color` are plain hex strings applied as inline styles (same
 * controlled-color pattern as `accent_color`), not a new set of Tailwind
 * classes to maintain. `border_color` set with no `background_color`
 * renders as an outline-style button (transparent fill, colored border
 * and text) — there's no separate "filled but also has a visible border"
 * knob, that combination wasn't a real design case worth a third state.
 * `rounded`/`size`/`border_width` added 2026-08-06 — see
 * `theme-cta-style.ts`'s `themeButtonClassName`.
 *
 * `action`/`product_id` added 2026-08-20 — see the root AGENTS.md's
 * "Product catalog + ordering" section for the "owner-composed product
 * promo block" design this is one half of (`ContainerBlock.
 * link_product_id`'s stretched-link overlay is the other half). Always
 * rendered `relative z-10` (regardless of `action`) so it stays clickable
 * above that overlay whenever this button sits inside a product-linked
 * container — a plain "link" button needs this exactly as much as an
 * "add_to_cart" one, since either would otherwise have its own click
 * swallowed by the overlay's higher paint order over ordinary content
 * (see ContainerBlock's own doc comment for the paint-order reasoning). */
export function ButtonBlock({
  label,
  href,
  background_color,
  text_color,
  border_color,
  rounded,
  size = "lg",
  border_width,
  width,
  action = "link",
  product_id,
  path,
}: ButtonBlockData & { path: string }) {
  const style: CSSProperties = {};
  if (background_color) style.backgroundColor = background_color;
  if (text_color) style.color = text_color;
  if (border_color) style.borderColor = border_color;

  const [cartStatus, setCartStatus] = React.useState<"idle" | "adding" | "added" | "error">("idle");

  async function handleAddToCart() {
    if (product_id == null) return;
    setCartStatus("adding");
    try {
      await addToCart(product_id, 1);
      setCartStatus("added");
    } catch {
      setCartStatus("error");
    }
  }

  const className = `relative z-10 ${themeButtonClassName({ size, rounded, border_width })}`;
  const styleProp = Object.keys(style).length > 0 ? style : undefined;

  return (
    <Editable
      as="div"
      path={path}
      fieldType="block-button"
      value={{
        type: "button",
        label,
        href,
        background_color,
        text_color,
        border_color,
        rounded,
        size,
        border_width,
        width,
        action,
        product_id,
      }}
    >
      {action === "add_to_cart" ? (
        <Button
          size={size}
          variant={border_color && !background_color ? "outline" : "default"}
          className={className}
          style={styleProp}
          disabled={product_id == null || cartStatus === "adding"}
          onClick={handleAddToCart}
        >
          <ShoppingCart className="size-4" />
          {cartStatus === "added" ? "Added" : cartStatus === "adding" ? "Adding…" : cartStatus === "error" ? "Couldn't add" : label}
        </Button>
      ) : (
        <Button
          size={size}
          variant={border_color && !background_color ? "outline" : "default"}
          nativeButton={false}
          render={<Link href={href} />}
          className={className}
          style={styleProp}
        >
          {label}
        </Button>
      )}
    </Editable>
  );
}
