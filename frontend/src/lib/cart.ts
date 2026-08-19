import { apiFetch } from "@/lib/api";
import { getChatSessionId } from "@/lib/chat";

/** The deterministic, non-LLM add-to-cart mutation (2026-08-19,
 * `POST /api/cart/add`, backend/apis/products.py's public_router) — the
 * ONE call site three surfaces share: the ProductList Block, a product's
 * own detail page, and the chatbot's own product cards. Reuses the same
 * chat_session_id identity as /api/chat (via getChatSessionId) so a
 * visitor's cart never splits between "things clicked on a page" and
 * "things said in chat" — both resolve to the same Order. */

export type CartAddResult = {
  order_id: number;
  total_amount: number;
};

export function addToCart(productId: number, quantity = 1) {
  return apiFetch<CartAddResult>("/api/cart/add", {
    method: "POST",
    body: { session_id: getChatSessionId(), product_id: productId, quantity },
  });
}

// --- Cart / checkout pages (2026-08-20) -----------------------------------
// GET /api/cart, POST /api/cart/update, POST /api/cart/checkout —
// backend/apis/products.py's public_router. Same session_id identity as
// addToCart above, so /cart and /checkout always show exactly what
// chat/product-page add-to-cart already built up.

export type CartItem = {
  id: number;
  product_id: number | null;
  item_name_snapshot: string;
  unit_price_snapshot: number;
  quantity: number;
  subtotal: number;
};

export type Cart = {
  id: number;
  contact_email: string | null;
  contact_name: string | null;
  status: string | null;
  is_open: boolean;
  pickup_time: string | null;
  note: string | null;
  total_amount: number;
  items: CartItem[];
  created_at: string;
};

/** `null` (not thrown/404) for "no cart yet" — a first-time visitor with
 * an empty cart is a normal state, not an error. */
export function getCart(): Promise<Cart | null> {
  return apiFetch<Cart | null>(`/api/cart?session_id=${encodeURIComponent(getChatSessionId())}`);
}

/** Powers /cart's quantity +/- and Remove controls — `quantityDelta` can
 * be negative (Remove sends -(current quantity)). Reuses the exact same
 * backend delta-application code addToCart's own POST /cart/add does, so
 * there's one order-mutation path regardless of which UI triggered it. */
export function updateCartItem(productId: number, quantityDelta: number) {
  return apiFetch<CartAddResult>("/api/cart/update", {
    method: "POST",
    body: { session_id: getChatSessionId(), product_id: productId, quantity_delta: quantityDelta },
  });
}

export type CheckoutInput = {
  contact_email?: string | null;
  contact_name?: string | null;
  pickup_time?: string | null;
  note?: string | null;
};

/** Finalizes the cart — no real payment (see the root AGENTS.md), just
 * records contact/pickup details and flips the order closed (is_open:
 * false, mirrors the owner dashboard's own "no more add-ons" toggle). */
export function checkoutCart(input: CheckoutInput) {
  return apiFetch<Cart>("/api/cart/checkout", {
    method: "POST",
    body: { session_id: getChatSessionId(), ...input },
  });
}
