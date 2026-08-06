import { cn } from "@/lib/utils";
import { ChatControlRenderer } from "@/components/modules/chat/chat-control-renderer";
import { SourceCitationList } from "@/components/common/source-citation";
import type { ChatMessage } from "@/lib/types";

type ChatMessageBubbleProps = {
  message: ChatMessage;
  onControlSubmit: (value: string | string[]) => void;
};

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
        <p className="leading-relaxed whitespace-pre-wrap">{message.content}</p>
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
