import { Paperclip } from "lucide-react";

import { cn } from "@/lib/utils";
import { ChatControlRenderer } from "@/components/modules/chat/chat-control-renderer";
import { SourceCitationList } from "@/components/common/source-citation";
import type { ChatMessage } from "@/lib/types";

type ChatMessageBubbleProps = {
  message: ChatMessage;
  onControlSubmit: (value: string | string[]) => void;
};

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

function isImageUrl(url: string) {
  const lower = url.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function ChatMessageBubble({ message, onControlSubmit }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
          isUser
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-muted",
        )}
      >
        {message.attachmentUrl ? (
          isImageUrl(message.attachmentUrl) ? (
            // Backend-hosted attachment, not a local blob — plain <img>,
            // same reasoning as ThemeImageBox (no host known ahead of time).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={message.attachmentUrl}
              alt="Attached file"
              className="mb-2 max-h-48 rounded-lg object-contain"
            />
          ) : (
            <a
              href={message.attachmentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "mb-2 flex items-center gap-1.5 truncate rounded-lg border px-2 py-1.5 text-xs underline underline-offset-2",
                isUser ? "border-primary-foreground/30" : "border-border",
              )}
            >
              <Paperclip className="size-3 shrink-0" />
              Attached file
            </a>
          )
        ) : null}
        {message.content ? <p className="leading-relaxed whitespace-pre-wrap">{message.content}</p> : null}
        {!isUser && message.sources?.length ? (
          <SourceCitationList sources={message.sources} className="mt-2" />
        ) : null}
        {!isUser && message.control ? (
          <ChatControlRenderer control={message.control} onSubmit={onControlSubmit} />
        ) : null}
      </div>
    </div>
  );
}
