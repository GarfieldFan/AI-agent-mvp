"use client";

import * as React from "react";
import Link from "next/link";
import { ClipboardList, MessagesSquare, ShoppingBag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ChatMessageBubble } from "@/components/modules/chat/chat-message-bubble";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CrmEntry } from "@/lib/crm";
import {
  getMyChatSessionMessages,
  listMyChatSessions,
  listMyCrmEntries,
  listMyOrders,
  type MyChatMessageSummary,
  type MyChatSessionSummary,
} from "@/lib/my-account";
import type { Order } from "@/lib/orders";

function noop() {
  // Historical transcript messages never carry a `control` field — see
  // components/modules/chat-session-viewer-panel.tsx's identical note.
}

/** "My Account" — self-service, account-scoped view of a logged-in
 * visitor's own orders/CRM entries/chat history (2026-08-22, "user
 * isolation", backend/apis/my_account.py). Any logged-in account (any
 * role, via lib/auth.ts's stored JWT) can see this page — it shows
 * nothing but that account's OWN data, enforced server-side by
 * apis/deps.py's require_authenticated_user + an email match on every
 * query, never trusted client-side. A visitor who isn't logged in sees a
 * prompt to log in (or sign in with Google, on /login) instead — this
 * page is the reason a social login is worth having at all: somewhere
 * to actually see your own history afterward. */
export function AccountPage() {
  const auth = useAuth();
  const [orders, setOrders] = React.useState<Order[] | null>(null);
  const [crmEntries, setCrmEntries] = React.useState<CrmEntry[] | null>(null);
  const [sessions, setSessions] = React.useState<MyChatSessionSummary[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = React.useState<number | null>(null);
  const [messages, setMessages] = React.useState<MyChatMessageSummary[] | null>(null);
  const [messagesError, setMessagesError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    if (!auth.token) return;
    Promise.all([listMyOrders(), listMyCrmEntries(), listMyChatSessions()])
      .then(([ordersResult, crmResult, sessionsResult]) => {
        setOrders(ordersResult.items);
        setCrmEntries(crmResult);
        setSessions(sessionsResult);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load your account data."));
  }, [auth.token]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  function handleOpenSession(id: number) {
    setOpenSessionId(id);
    setMessages(null);
    setMessagesError(null);
    getMyChatSessionMessages(id)
      .then(setMessages)
      .catch((err) => setMessagesError(err instanceof ApiError ? err.message : "Failed to load transcript."));
  }

  if (!auth.token) {
    return (
      <Container className="py-12">
        <EmptyState
          title="Sign in to see your account"
          description="Log in to view your past orders, requests, and chat history."
          action={
            <Button render={<Link href="/login" />} nativeButton={false}>
              Go to login
            </Button>
          }
        />
      </Container>
    );
  }

  return (
    <Container className="space-y-8 py-8">
      <PageHeader title="My account" description={`Signed in as ${auth.email}`} />

      {loadError ? <ErrorMessage description={loadError} onRetry={refresh} /> : null}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShoppingBag className="h-4 w-4" />
          My orders
        </h2>
        {orders === null && !loadError ? <LoadingSpinner label="Loading orders…" /> : null}
        {orders !== null && orders.length === 0 ? (
          <EmptyState title="No orders yet" description="Anything you order will show up here." />
        ) : null}
        {orders?.map((order) => (
          <div key={order.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
            <div>
              <p className="font-medium">Order #{order.id}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(order.created_at).toLocaleString()} · {order.items.length} item
                {order.items.length === 1 ? "" : "s"} · ${order.total_amount.toFixed(2)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{order.status ?? "new"}</Badge>
              <Badge variant={order.payment_status === "paid" ? "default" : "outline"}>{order.payment_status}</Badge>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ClipboardList className="h-4 w-4" />
          My requests
        </h2>
        {crmEntries === null && !loadError ? <LoadingSpinner label="Loading requests…" /> : null}
        {crmEntries !== null && crmEntries.length === 0 ? (
          <EmptyState title="No requests yet" description="Appointments, quotes, or claims you've submitted show up here." />
        ) : null}
        {crmEntries?.map((entry) => (
          <div key={entry.crm_id} className="space-y-1 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{entry.category ?? "Inquiry"}</p>
              <Badge variant="outline">{entry.status}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{entry.summary}</p>
            <p className="text-xs text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</p>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <MessagesSquare className="h-4 w-4" />
          My chat history
        </h2>
        {sessions === null && !loadError ? <LoadingSpinner label="Loading chat history…" /> : null}
        {sessions !== null && sessions.length === 0 ? (
          <EmptyState title="No chat history yet" description="Conversations from the site chatbot show up here." />
        ) : null}
        {sessions?.map((session) => (
          <div key={session.id} className="space-y-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Last active {new Date(session.last_seen_at).toLocaleString()} · {session.message_count} message
                {session.message_count === 1 ? "" : "s"}
              </p>
              <Button size="sm" variant="outline" onClick={() => handleOpenSession(session.id)}>
                {openSessionId === session.id ? "Viewing" : "View"}
              </Button>
            </div>
            {openSessionId === session.id ? (
              <div className="space-y-2 border-t pt-2">
                {messagesError ? <ErrorMessage description={messagesError} onRetry={() => handleOpenSession(session.id)} /> : null}
                {messages === null && !messagesError ? <LoadingSpinner label="Loading transcript…" /> : null}
                {messages?.map((m) => (
                  <ChatMessageBubble
                    key={m.id}
                    message={{ id: String(m.id), role: m.role, content: m.content, createdAt: m.created_at }}
                    onControlSubmit={noop}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </section>
    </Container>
  );
}
