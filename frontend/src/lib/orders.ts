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

export function listOrders() {
  return apiFetch<Order[]>("/api/agent/orders");
}

export function updateOrder(id: number, input: OrderUpdateInput) {
  return apiFetch<Order>(`/api/agent/orders/${id}`, { method: "PATCH", body: input });
}

export function listOrderStatusOptions() {
  return apiFetch<{ status_options: string[] }>("/api/agent/order-status-options");
}
