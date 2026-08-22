"use client";

import * as React from "react";
import { ShoppingCart } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { Pagination } from "@/components/common/pagination";
import { ApiError } from "@/lib/api";
import { listOrders, listOrderStatusOptions, updateOrder, updateOrderItemServed, type Order } from "@/lib/orders";

const FALLBACK_STATUS_OPTIONS = ["received", "preparing", "ready", "delivered", "paid", "refunded"];
const PAGE_SIZE = 20;

/** Orders captured as visitors talk to the chatbot against the Product
 * catalog (ProductPanel) — see backend/models.py's Order/OrderItem
 * docstrings and apis/chat.py's `_maybe_capture_order`. Status labels
 * come from the owner agent's `set_order_status_options` tool (2026-08-19,
 * see the root AGENTS.md) — no manual editor for the option list here,
 * same posture as ReviewQueuePanel having none either. `is_open` is a
 * separate, explicit switch from `status` — it's the one thing that
 * actually gates whether a visitor's next chat turn can still add to
 * this same order ("加单") or has to start a new one.
 *
 * **Search/status/open filtering is server-side** (2026-08-20, moved off
 * a client-side `.filter()` the same session pagination was added — see
 * the root AGENTS.md) — pagination made client-side filtering silently
 * wrong (a match on a page that isn't loaded just looks like "no such
 * order"), still deterministic SQL, never an LLM (matches this app's own
 * "result filtering is pure code" principle, `cart.search_products`). */
export function OrderPanel() {
  const [orders, setOrders] = React.useState<Order[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [statusOptions, setStatusOptions] = React.useState<string[]>(FALLBACK_STATUS_OPTIONS);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [fieldErrorByOrder, setFieldErrorByOrder] = React.useState<Record<number, string>>({});

  const [searchInput, setSearchInput] = React.useState("");
  const [searchText, setSearchText] = React.useState(""); // debounced
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [openFilter, setOpenFilter] = React.useState<"all" | "open" | "closed">("all");

  // Debounce the search box (2026-08-20) — fires a server request per
  // keystroke otherwise, wasteful for something that's just going to be
  // superseded by the next keystroke a moment later.
  React.useEffect(() => {
    const id = window.setTimeout(() => setSearchText(searchInput), 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // Any filter change invalidates the current page — jump back to 1
  // rather than risk landing on a now-out-of-range offset.
  React.useEffect(() => {
    setPage(1);
  }, [searchText, statusFilter, openFilter]);

  const refresh = React.useCallback(() => {
    listOrders({
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      q: searchText || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      isOpen: openFilter === "all" ? undefined : openFilter === "open",
    })
      .then((result) => {
        setOrders(result.items);
        setTotal(result.total);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load orders."));
  }, [page, searchText, statusFilter, openFilter]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    listOrderStatusOptions()
      .then((result) =>
        setStatusOptions(result.status_options.length > 0 ? result.status_options : FALLBACK_STATUS_OPTIONS),
      )
      .catch(() => setStatusOptions(FALLBACK_STATUS_OPTIONS));
  }, []);

  // Short polling (2026-08-20), not a websocket — the owner's own
  // explicit tradeoff call: kitchen-status staleness of a few seconds is
  // fine, and this is far less infra than a real push channel would need
  // (this app runs one uvicorn worker, see rate_limit.py's own docstring
  // — broadcasting a push event across workers/replicas isn't free the
  // way it is here). Gated on document.visibilityState so a background
  // or minimized tab stops polling entirely, not just this one panel.
  // Refetches immediately when the tab regains focus too, so switching
  // back doesn't wait out the interval.
  React.useEffect(() => {
    const POLL_MS = 20_000;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    function handleVisibility() {
      if (document.visibilityState === "visible") refresh();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
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

  async function handleServedToggle(order: Order, itemId: number, served: boolean) {
    setOrders((prev) =>
      prev
        ? prev.map((o) =>
            o.id === order.id ? { ...o, items: o.items.map((i) => (i.id === itemId ? { ...i, served } : i)) } : o,
          )
        : prev,
    );
    try {
      await updateOrderItemServed(itemId, served);
      setFieldErrorByOrder((prev) => {
        const next = { ...prev };
        delete next[order.id];
        return next;
      });
    } catch (err) {
      setOrders((prev) =>
        prev
          ? prev.map((o) =>
              o.id === order.id
                ? { ...o, items: o.items.map((i) => (i.id === itemId ? { ...i, served: !served } : i)) }
                : o,
            )
          : prev,
      );
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

  const isFiltered = Boolean(searchText) || statusFilter !== "all" || openFilter !== "all";

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

      {total === 0 && !isFiltered ? (
        <EmptyState icon={ShoppingCart} title="No orders yet" description="Orders placed in chat will show up here." />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search order #, name, email, item…"
            className="h-8 w-56 text-xs"
          />
          <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statusOptions.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={openFilter} onValueChange={(v) => v && setOpenFilter(v as "all" | "open" | "closed")}>
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue placeholder="Open?" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Open + closed</SelectItem>
              <SelectItem value="open">Open only</SelectItem>
              <SelectItem value="closed">Closed only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {total === 0 && isFiltered ? (
        <EmptyState icon={ShoppingCart} title="No matching orders" description="Try a different search or filter." />
      ) : null}

      {total > 0 ? <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} /> : null}

      <div className="space-y-2">
        {orders.map((order) => (
          <details key={order.id} className="rounded-lg border p-3">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono text-muted-foreground">#{order.id}</span>{" "}
                {order.contact_name || order.contact_email ? `${order.contact_name || order.contact_email} — ` : ""}$
                {order.total_amount.toFixed(2)}
                {order.pickup_time ? ` — pickup ${order.pickup_time}` : ""}
                <Badge
                  variant={
                    order.payment_status === "paid"
                      ? "default"
                      : order.payment_status === "failed"
                        ? "destructive"
                        : "outline"
                  }
                  className="text-xs"
                >
                  {order.payment_status}
                </Badge>
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
                      <th className="pr-2 font-normal">Note</th>
                      <th className="pr-2 font-normal">Qty</th>
                      <th className="pr-2 font-normal">Unit</th>
                      <th className="pr-2 font-normal">Subtotal</th>
                      <th className="font-normal">Served</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => (
                      <tr key={item.id}>
                        <td className="pr-2">{item.item_name_snapshot}</td>
                        <td className="pr-2 text-muted-foreground">{item.comment ?? ""}</td>
                        <td className="pr-2">{item.quantity}</td>
                        <td className="pr-2">${item.unit_price_snapshot.toFixed(2)}</td>
                        <td className="pr-2">${item.subtotal.toFixed(2)}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <Switch
                            checked={item.served}
                            onCheckedChange={(checked) => handleServedToggle(order, item.id, checked)}
                          />
                        </td>
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
