import { apiFetch } from "@/lib/api";

/** Orders captured against the Product catalog (lib/products.ts) as
 * visitors talk to the chatbot — see backend/models.py's Order/OrderItem
 * docstrings and apis/chat.py's `_maybe_capture_order`. `is_open` is a
 * deliberate, separate signal from `status` (a free-text label
 * owner-agent sets via set_order_status_options) — the code needs a hard
 * boolean for "still accepting chat add-ons," which a free-text status
 * can't reliably provide. */

export type OrderItem = {
  id: number;
  product_id: number | null;
  item_name_snapshot: string;
  unit_price_snapshot: number;
  quantity: number;
  subtotal: number;
  comment: string | null;
  served: boolean;
};

export type Order = {
  id: number;
  contact_email: string | null;
  contact_name: string | null;
  status: string | null;
  is_open: boolean;
  pickup_time: string | null;
  note: string | null;
  total_amount: number;
  items: OrderItem[];
  created_at: string;
};

export type OrderUpdateInput = {
  status?: string;
  is_open?: boolean;
};

export type OrderListResult = {
  items: Order[];
  total: number;
};

export type OrderListFilters = {
  limit?: number;
  offset?: number;
  q?: string;
  status?: string;
  isOpen?: boolean;
};

/** Paginated + server-side filtered (2026-08-20, was a plain unbounded
 * fetch with the search/status/open filtering done client-side in
 * `OrderPanel` — moved server-side once pagination made client-side
 * filtering incorrect, see the root `AGENTS.md`). */
export function listOrders(filters: OrderListFilters = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(filters.limit ?? 20));
  params.set("offset", String(filters.offset ?? 0));
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.isOpen !== undefined) params.set("is_open", String(filters.isOpen));
  return apiFetch<OrderListResult>(`/api/agent/orders?${params.toString()}`);
}

export function updateOrder(id: number, input: OrderUpdateInput) {
  return apiFetch<Order>(`/api/agent/orders/${id}`, { method: "PATCH", body: input });
}

export function listOrderStatusOptions() {
  return apiFetch<{ status_options: string[] }>("/api/agent/order-status-options");
}

/** Staff-side per-line kitchen control (2026-08-20) — toggles whether a
 * dish has gone out. Returns the whole parent Order (not just the item),
 * matching updateOrder's own shape. Never exposed to owner-agent — see
 * backend/models.py's OrderItem docstring for why this is a live
 * kitchen-floor action, not a cheap-to-adjust config value. */
export function updateOrderItemServed(itemId: number, served: boolean) {
  return apiFetch<Order>(`/api/agent/order-items/${itemId}`, { method: "PATCH", body: { served } });
}
