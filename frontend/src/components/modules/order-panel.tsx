"use client";

import * as React from "react";
import { ShoppingCart } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import { listOrders, listOrderStatusOptions, updateOrder, type Order } from "@/lib/orders";

const FALLBACK_STATUS_OPTIONS = ["received", "preparing", "ready", "delivered", "paid", "refunded"];

/** Orders captured as visitors talk to the chatbot against the Product
 * catalog (ProductPanel) — see backend/models.py's Order/OrderItem
 * docstrings and apis/chat.py's `_maybe_capture_order`. Status labels
 * come from the owner agent's `set_order_status_options` tool (2026-08-19,
 * see the root AGENTS.md) — no manual editor for the option list here,
 * same posture as ReviewQueuePanel having none either. `is_open` is a
 * separate, explicit switch from `status` — it's the one thing that
 * actually gates whether a visitor's next chat turn can still add to
 * this same order ("加单") or has to start a new one. */
export function OrderPanel() {
  const [orders, setOrders] = React.useState<Order[] | null>(null);
  const [statusOptions, setStatusOptions] = React.useState<string[]>(FALLBACK_STATUS_OPTIONS);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [fieldErrorByOrder, setFieldErrorByOrder] = React.useState<Record<number, string>>({});

  const refresh = React.useCallback(() => {
    Promise.all([listOrders(), listOrderStatusOptions()])
      .then(([orderResult, optionsResult]) => {
        setOrders(orderResult);
        setStatusOptions(optionsResult.status_options.length > 0 ? optionsResult.status_options : FALLBACK_STATUS_OPTIONS);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load orders."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleStatusChange(order: Order, status: string) {
    const previous = order.status;
    setOrders((prev) => (prev ? prev.map((o) => (o.id === order.id ? { ...o, status } : o)) : prev));
    try {
      await updateOrder(order.id, { status });
      setFieldErrorByOrder((prev) => {
        const next = { ...prev };
        delete next[order.id];
        return next;
      });
    } catch (err) {
      setOrders((prev) => (prev ? prev.map((o) => (o.id === order.id ? { ...o, status: previous } : o)) : prev));
      setFieldErrorByOrder((prev) => ({ ...prev, [order.id]: err instanceof ApiError ? err.message : "Update failed." }));
    }
  }

  async function handleOpenToggle(order: Order, isOpen: boolean) {
    const previous = order.is_open;
    setOrders((prev) => (prev ? prev.map((o) => (o.id === order.id ? { ...o, is_open: isOpen } : o)) : prev));
    try {
      await updateOrder(order.id, { is_open: isOpen });
      setFieldErrorByOrder((prev) => {
        const next = { ...prev };
        delete next[order.id];
        return next;
      });
    } catch (err) {
      setOrders((prev) => (prev ? prev.map((o) => (o.id === order.id ? { ...o, is_open: previous } : o)) : prev));
      setFieldErrorByOrder((prev) => ({ ...prev, [order.id]: err instanceof ApiError ? err.message : "Update failed." }));
    }
  }

  if (loadError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={loadError} onRetry={refresh} />
      </div>
    );
  }

  if (!orders) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading orders…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <ShoppingCart className="h-5 w-5" />
          Orders
        </h3>
        <p className="text-xs text-muted-foreground">
          Captured automatically as visitors order in chat. &quot;Open for add-ons&quot; controls whether
          a visitor can still add to this same order in a follow-up message — turn it off once it&apos;s
          out the door.
        </p>
      </div>

      {orders.length === 0 ? (
        <EmptyState icon={ShoppingCart} title="No orders yet" description="Orders placed in chat will show up here." />
      ) : null}

      <div className="space-y-2">
        {orders.map((order) => (
          <details key={order.id} className="rounded-lg border p-3">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {order.contact_name || order.contact_email || `Order #${order.id}`} — ${order.total_amount.toFixed(2)}
                {order.pickup_time ? ` — pickup ${order.pickup_time}` : ""}
              </span>
              <span className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <Select value={order.status ?? undefined} onValueChange={(v) => v && handleStatusChange(order, v)}>
                  <SelectTrigger className="h-7 w-32 text-xs">
                    <SelectValue placeholder="status" />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="flex items-center gap-1.5">
                  <Switch checked={order.is_open} onCheckedChange={(checked) => handleOpenToggle(order, checked)} />
                  <span className="text-xs text-muted-foreground">{order.is_open ? "Open" : "Closed"}</span>
                </span>
              </span>
            </summary>
            <div className="mt-2 space-y-2 text-xs">
              {fieldErrorByOrder[order.id] ? <p className="text-destructive">{fieldErrorByOrder[order.id]}</p> : null}
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="pr-2 font-normal">Item</th>
                      <th className="pr-2 font-normal">Qty</th>
                      <th className="pr-2 font-normal">Unit</th>
                      <th className="font-normal">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => (
                      <tr key={item.id}>
                        <td className="pr-2">{item.item_name_snapshot}</td>
                        <td className="pr-2">{item.quantity}</td>
                        <td className="pr-2">${item.unit_price_snapshot.toFixed(2)}</td>
                        <td>${item.subtotal.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="font-medium">Total: ${order.total_amount.toFixed(2)}</p>
              {order.note ? <p className="text-muted-foreground">Note: {order.note}</p> : null}
              {order.contact_email ? <p className="text-muted-foreground">Contact: {order.contact_email}</p> : null}
              {!order.status ? <Badge variant="outline" className="text-xs">no status set</Badge> : null}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
