"use client";

import * as React from "react";
import { MessagesSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { Pagination } from "@/components/common/pagination";
import { ChatMessageBubble } from "@/components/modules/chat/chat-message-bubble";
import { ApiError } from "@/lib/api";
import {
  getChatSessionMessages,
  listChatSessions,
  type ChatSessionMessagesResult,
  type ChatSessionSummary,
} from "@/lib/chat-sessions";

const SESSION_PAGE_SIZE = 20;
const MESSAGE_PAGE_SIZE = 50;

function noop() {
  // Historical transcript messages never carry a `control` field, so
  // ChatControlRenderer inside ChatMessageBubble never actually fires
  // this — required prop, not meaningfully callable here.
}

function TranscriptSheet({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const [page, setPage] = React.useState(1);
  const [result, setResult] = React.useState<ChatSessionMessagesResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getChatSessionMessages(sessionId, MESSAGE_PAGE_SIZE, (page - 1) * MESSAGE_PAGE_SIZE)
      .then((res) => {
        setResult(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load transcript."));
  }, [sessionId, page]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {result ? result.session.user_email || result.session.session_key : `Session #${sessionId}`}
          </SheetTitle>
          {result ? (
            <p className="text-xs text-muted-foreground">
              {result.total} message{result.total === 1 ? "" : "s"} — started{" "}
              {new Date(result.session.created_at).toLocaleString()}
            </p>
          ) : null}
        </SheetHeader>

        <div className="flex-1 space-y-3 overflow-y-auto px-4">
          {error ? (
            <ErrorMessage description={error} onRetry={refresh} />
          ) : !result ? (
            <LoadingSpinner label="Loading transcript…" />
          ) : result.items.length === 0 ? (
            <EmptyState title="No messages" description="This session has no recorded turns." />
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 pb-3">
                {result.items.map((m) => (
                  <ChatMessageBubble
                    key={m.id}
                    message={{ id: String(m.id), role: m.role, content: m.content, createdAt: m.created_at }}
                    onControlSubmit={noop}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>

        {result && result.total > MESSAGE_PAGE_SIZE ? (
          <div className="shrink-0 border-t px-4 py-3">
            <Pagination page={page} pageSize={MESSAGE_PAGE_SIZE} total={result.total} onPageChange={setPage} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Admin/owner read-only viewer for the chat sessions/messages `/api/chat`
 * already persists on every turn (2026-08-21, backend/apis/chat_sessions.py)
 * — closes a real, long-flagged dashboard gap: only `ReportPanel`'s own
 * aggregate day-by-day counts existed before this; nothing let an owner
 * actually read what a visitor said. Purely a reader — no write actions
 * anywhere in this panel. */
export function ChatSessionViewerPanel() {
  const [sessions, setSessions] = React.useState<ChatSessionSummary[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [searchInput, setSearchInput] = React.useState("");
  const [searchText, setSearchText] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = React.useState<number | null>(null);

  // Resets `page` in the SAME debounced callback that updates
  // `searchText`, rather than a separate effect watching `searchText` —
  // an effect that only exists to reset one piece of state whenever
  // another derived value changes trips react-hooks/set-state-in-effect
  // (see the root AGENTS.md's "Known gotchas" for this project's other
  // hits of the same rule); folding both updates into one place avoids
  // the pattern entirely instead of working around the lint rule.
  React.useEffect(() => {
    const id = window.setTimeout(() => {
      setSearchText(searchInput);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const refresh = React.useCallback(() => {
    listChatSessions({ limit: SESSION_PAGE_SIZE, offset: (page - 1) * SESSION_PAGE_SIZE, q: searchText || undefined })
      .then((result) => {
        setSessions(result.items);
        setTotal(result.total);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load chat sessions."));
  }, [page, searchText]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <MessagesSquare className="h-4 w-4" />
          Chat sessions
        </h3>
        <p className="text-xs text-muted-foreground">
          Every visitor conversation logged from the public chatbot — read-only, for reviewing what
          people actually ask. Sorted by most recently active.
        </p>
      </div>

      <Input
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        placeholder="Search by visitor email or session id…"
        className="max-w-sm"
      />

      {loadError ? (
        <ErrorMessage description={loadError} onRetry={refresh} />
      ) : sessions.length === 0 ? (
        <EmptyState title="No sessions yet" description="Once a visitor chats on the public site, sessions will show up here." />
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{session.user_email || session.session_key}</p>
                <p className="text-xs text-muted-foreground">
                  Last active {new Date(session.last_seen_at).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">
                  {session.message_count} message{session.message_count === 1 ? "" : "s"}
                </Badge>
                <Button size="sm" variant="outline" onClick={() => setOpenSessionId(session.id)}>
                  View transcript
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {total > SESSION_PAGE_SIZE ? (
        <Pagination page={page} pageSize={SESSION_PAGE_SIZE} total={total} onPageChange={setPage} />
      ) : null}

      {openSessionId !== null ? (
        <TranscriptSheet sessionId={openSessionId} onClose={() => setOpenSessionId(null)} />
      ) : null}
    </div>
  );
}
