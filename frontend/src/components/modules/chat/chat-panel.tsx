"use client";

import * as React from "react";
import { Loader2, Paperclip, Send, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatMessageBubble } from "@/components/modules/chat/chat-message-bubble";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { ApiError } from "@/lib/api";
import { sendChatMessage, uploadChatAttachment, type ChatApiTurn } from "@/lib/chat";
import { requestResumeCode, verifyResumeCode } from "@/lib/crm-resume";
import { fileToBase64 } from "@/lib/file";
import type { ChatMessage, ChatOption } from "@/lib/types";
import { cn } from "@/lib/utils";

// Kept in sync with backend/apis/chat.py's CHAT_UPLOAD_EXTENSIONS — the
// backend re-validates independently, this is purely so the native file
// picker doesn't even offer an unsupported type.
const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf";

// The intent-triage steps (0-3) below are a scripted local flow, not an LLM
// call — see the project plan's chatbot module for the
// intent-recognition -> structured-field-capture -> CRM/human handoff
// shape this mirrors. Once that flow completes ("done"), free-text
// messages go to the real backend (POST /api/chat — see backend/apis/chat.py),
// which is RAG-grounded as of 2026-08-04: it answers from uploaded
// documents when relevant (rendered below via SourceCitationList in
// ChatMessageBubble) and falls back to plain conversation otherwise.
// TODO(Phase 3): replace the scripted steps with LLM-driven
// `{ type, options }` responses too, once the backend can produce them.
const CATEGORY_OPTIONS: ChatOption[] = [
  { label: "General inquiry", value: "general" },
  { label: "Technical support", value: "support" },
  { label: "Careers", value: "careers" },
];

const TAG_OPTIONS: ChatOption[] = [
  { label: "Urgent", value: "urgent" },
  { label: "Needs a callback", value: "callback" },
  { label: "Just browsing", value: "browsing" },
];

const CHANNEL_OPTIONS: ChatOption[] = [
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
  { label: "No preference", value: "none" },
];

function labelFor(options: ChatOption[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

type ChatPanelProps = {
  /** True when rendered inside `ChatBubbleWidget`'s own floating card —
   * that wrapper already supplies a border/rounded corners/shadow, so
   * this omits its own to avoid a visibly nested double-box look. The
   * `/chat` page's standalone usage is unaffected (defaults to `false`). */
  embedded?: boolean;
};

export function ChatPanel({ embedded = false }: ChatPanelProps) {
  // Starts at 1 so it never collides with the seed message's "msg-0" — kept
  // out of the useState initializer below since refs must not be read
  // during render, only from event handlers.
  const idRef = React.useRef(1);
  const nextId = () => `msg-${idRef.current++}`;

  const [messages, setMessages] = React.useState<ChatMessage[]>(() => [
    {
      id: "msg-0",
      role: "assistant",
      content: "Hi! I can help route your question. What would you like help with?",
      control: { type: "radio", options: CATEGORY_OPTIONS },
      createdAt: new Date(0).toISOString(),
    },
  ]);
  const [step, setStep] = React.useState<0 | 1 | 2 | 3 | "done">(0);
  const [draft, setDraft] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Uploaded ahead of send (POST /api/chat/upload) — see lib/chat.ts's
  // uploadChatAttachment. `uploading`/`uploadError` track that pre-send
  // step; `pendingAttachment` itself is only ever set once the upload
  // succeeded, ready to ride along on the next sendChatMessage call.
  const [pendingAttachment, setPendingAttachment] = React.useState<{ file: File; url: string } | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Drag-and-drop over the whole panel, not just the paperclip button
  // (2026-08-20 — the click-to-browse path already existed, dropping a
  // file anywhere on the chat window didn't work at all). `dragCounter`
  // (not a plain boolean) is the standard fix for the "dragleave fires
  // when the pointer crosses into a child element, flickering the
  // overlay off mid-drag" browser quirk — dragenter/dragleave fire once
  // per element boundary crossed, so only clear the active state once
  // the count returns to 0 (left every nested element, not just one).
  const [dragActive, setDragActive] = React.useState(false);
  const dragCounter = React.useRef(0);

  // "Continue a previous request" (2026-08-20, backend/apis/crm_resume.py)
  // — deliberately independent of the chat/LLM layer entirely: both
  // calls below are plain REST, never routed through sendChatMessage or
  // any LLM-driven intent detection. Collapsed by default (`resumeOpen`)
  // so it doesn't compete with the scripted intake flow above; expands
  // into a two-step form (email, then code) inline above the composer.
  const [resumeOpen, setResumeOpen] = React.useState(false);
  const [resumeStep, setResumeStep] = React.useState<"email" | "code">("email");
  const [resumeEmail, setResumeEmail] = React.useState("");
  const [resumeCode, setResumeCode] = React.useState("");
  const [resumeStatus, setResumeStatus] = React.useState<"idle" | "sending" | "verifying" | "error">("idle");
  const [resumeError, setResumeError] = React.useState<string | null>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending, error]);

  function pushMessage(message: Omit<ChatMessage, "id" | "createdAt">) {
    setMessages((prev) => [
      ...prev,
      { ...message, id: nextId(), createdAt: new Date(0).toISOString() },
    ]);
  }

  function handleControlSubmit(value: string | string[]) {
    if (step === 0 && typeof value === "string") {
      pushMessage({ role: "user", content: labelFor(CATEGORY_OPTIONS, value) });
      pushMessage({
        role: "assistant",
        content: "Got it. Do any of these apply to you? (select all that fit)",
        control: { type: "checkbox", options: TAG_OPTIONS },
      });
      setStep(1);
      return;
    }

    if (step === 1 && Array.isArray(value)) {
      pushMessage({
        role: "user",
        content: value.map((v) => labelFor(TAG_OPTIONS, v)).join(", ") || "None",
      });
      pushMessage({
        role: "assistant",
        content: "Thanks — what's the best way to follow up with you?",
        control: { type: "select", options: CHANNEL_OPTIONS },
      });
      setStep(2);
      return;
    }

    if (step === 2 && typeof value === "string") {
      pushMessage({ role: "user", content: labelFor(CHANNEL_OPTIONS, value) });
      pushMessage({
        role: "assistant",
        content: "Anything else you'd like us to know? (optional — type below and send)",
        control: { type: "text" },
      });
      setStep(3);
    }
  }

  async function handleAttachmentSelect(file: File | null) {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const base64 = await fileToBase64(file);
      const { url } = await uploadChatAttachment(file.name, base64);
      setPendingAttachment({ file, url });
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed — try a smaller image or PDF.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleResumeRequestCode(event: React.FormEvent) {
    event.preventDefault();
    if (!resumeEmail.trim()) return;
    setResumeStatus("sending");
    setResumeError(null);
    try {
      await requestResumeCode(resumeEmail.trim());
      setResumeStep("code");
      setResumeStatus("idle");
    } catch (err) {
      setResumeError(err instanceof ApiError ? err.message : "Couldn't send a code — try again in a moment.");
      setResumeStatus("error");
    }
  }

  async function handleResumeVerifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (!resumeCode.trim()) return;
    setResumeStatus("verifying");
    setResumeError(null);
    try {
      const result = await verifyResumeCode(resumeEmail.trim(), resumeCode.trim());
      if (!result.resumed) {
        setResumeError("That code didn't work — check it and try again.");
        setResumeStatus("error");
        return;
      }
      const fields = result.collected_fields ?? {};
      const summary = Object.entries(fields)
        .map(([key, value]) => `${key.replace(/_/g, " ")}: ${value}`)
        .join(", ");
      pushMessage({
        role: "assistant",
        content: summary
          ? `Welcome back — I've pulled up your previous request. Here's what we have so far: ${summary}. Let's keep going.`
          : "Welcome back — I've pulled up your previous request. Let's keep going.",
      });
      setResumeOpen(false);
      setResumeStep("email");
      setResumeEmail("");
      setResumeCode("");
      setResumeStatus("idle");
    } catch (err) {
      setResumeError(err instanceof ApiError ? err.message : "Couldn't verify that code — try again in a moment.");
      setResumeStatus("error");
    }
  }

  function handleDragEnter(event: React.DragEvent) {
    event.preventDefault();
    if (pending || uploading) return;
    dragCounter.current += 1;
    if (event.dataTransfer.types.includes("Files")) setDragActive(true);
  }

  function handleDragOver(event: React.DragEvent) {
    // Merely hovering still needs preventDefault on every dragover event,
    // or the browser's default "reject the drop" behavior wins and onDrop
    // never fires at all.
    event.preventDefault();
  }

  function handleDragLeave(event: React.DragEvent) {
    event.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragActive(false);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    if (pending || uploading) return;
    const file = event.dataTransfer.files?.[0];
    if (file) handleAttachmentSelect(file);
  }

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && !pendingAttachment) || pending || uploading) return;

    const history: ChatApiTurn[] = messages
      .filter((message) => message.content)
      .map((message) => ({ role: message.role, content: message.content }));

    const attachmentUrl = pendingAttachment?.url;
    pushMessage({ role: "user", content: text, attachmentUrl });
    setDraft("");
    setPendingAttachment(null);
    setUploadError(null);
    setError(null);

    // step 3's "anything else?" used to short-circuit here with a canned
    // "that's been captured" reply and never actually call the backend —
    // found 2026-08-20 from a real report: a visitor who attached a file
    // right at this step had it silently discarded, never analyzed, never
    // captured into any CrmEntry/queue. CRM capture and attachment
    // analysis are both fully real now (unlike when this stub was
    // written), so step 3 gets exactly the same real backend call every
    // other turn does — no reason for it to be a dead end.
    if (step === 3) {
      setStep("done");
    }

    setPending(true);
    try {
      const { reply, sources, products, searchLink } = await sendChatMessage(text, history, attachmentUrl);
      pushMessage({
        role: "assistant",
        content: reply,
        sources: sources.length ? sources : undefined,
        products: products ?? undefined,
        searchLink: searchLink ?? undefined,
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not reach the chat backend.";
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className={cn("relative flex h-[32rem] flex-col overflow-hidden", !embedded && "rounded-xl border")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-primary bg-background/90">
          <Upload className="size-6 text-primary" aria-hidden="true" />
          <p className="text-sm font-medium text-primary">Drop a photo or PDF to attach</p>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1 p-4">
        <div className="flex flex-col gap-3">
          {messages.map((message) => (
            <ChatMessageBubble
              key={message.id}
              message={message}
              onControlSubmit={handleControlSubmit}
            />
          ))}
          {pending ? <LoadingSpinner label="Thinking…" className="pl-1" /> : null}
          {error ? (
            <ErrorMessage description={error} onRetry={() => setError(null)} />
          ) : null}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t">
        {!resumeOpen ? (
          <button
            type="button"
            onClick={() => setResumeOpen(true)}
            className="w-full px-3 pt-2 text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Continuing a previous request? Enter your code
          </button>
        ) : (
          <div className="space-y-1.5 px-3 pt-2">
            {resumeStep === "email" ? (
              <form onSubmit={handleResumeRequestCode} className="flex items-center gap-2">
                <Input
                  type="email"
                  value={resumeEmail}
                  onChange={(event) => setResumeEmail(event.target.value)}
                  placeholder="Email you used before"
                  className="h-8 flex-1 text-xs"
                  disabled={resumeStatus === "sending"}
                />
                <Button type="submit" size="sm" disabled={!resumeEmail.trim() || resumeStatus === "sending"}>
                  {resumeStatus === "sending" ? "Sending…" : "Send code"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Cancel"
                  onClick={() => {
                    setResumeOpen(false);
                    setResumeError(null);
                  }}
                >
                  <X className="size-3" />
                </Button>
              </form>
            ) : (
              <form onSubmit={handleResumeVerifyCode} className="flex items-center gap-2">
                <Input
                  value={resumeCode}
                  onChange={(event) => setResumeCode(event.target.value)}
                  placeholder="6-digit code"
                  className="h-8 flex-1 text-xs"
                  disabled={resumeStatus === "verifying"}
                />
                <Button type="submit" size="sm" disabled={!resumeCode.trim() || resumeStatus === "verifying"}>
                  {resumeStatus === "verifying" ? "Checking…" : "Continue"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Cancel"
                  onClick={() => {
                    setResumeOpen(false);
                    setResumeStep("email");
                    setResumeError(null);
                  }}
                >
                  <X className="size-3" />
                </Button>
              </form>
            )}
            {resumeStep === "email" ? (
              <p className="text-xs text-muted-foreground">
                If we find a matching request, we&apos;ll email you a code to continue it.
              </p>
            ) : null}
            {resumeStatus === "error" && resumeError ? <p className="text-xs text-destructive">{resumeError}</p> : null}
          </div>
        )}
        {pendingAttachment ? (
          <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
            <Paperclip className="size-3 shrink-0" />
            <span className="truncate">{pendingAttachment.file.name}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Remove attachment"
              onClick={() => setPendingAttachment(null)}
            >
              <X className="size-3" />
            </Button>
          </div>
        ) : null}
        {uploadError ? <p className="px-3 pt-2 text-xs text-destructive">{uploadError}</p> : null}

        <form onSubmit={handleSend} className="flex items-center gap-2 p-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            className="sr-only"
            onChange={(event) => handleAttachmentSelect(event.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Attach a photo or PDF"
            disabled={pending || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </Button>
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type a message…"
            className="flex-1"
            disabled={pending}
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send message"
            disabled={(!draft.trim() && !pendingAttachment) || pending || uploading}
          >
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
