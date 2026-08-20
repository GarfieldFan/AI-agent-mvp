import { FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RagSource } from "@/lib/types";

type SourceCitationListProps = {
  sources: RagSource[];
  className?: string;
};

/** Renders the source-attribution chips that accompany a RAG-grounded chat
 * reply (ChatMessageBubble) — the core "answers are traceable back to a
 * document/chunk" selling point of the RAG feature. Hovering a chip
 * previews the matched chunk. */
export function SourceCitationList({ sources, className }: SourceCitationListProps) {
  if (sources.length === 0) return null;

  return (
    <div className={className}>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Sources</p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((source, index) => (
          <Tooltip key={`${source.document_id}-${source.chunk_id}`}>
            <TooltipTrigger
              render={
                <Badge
                  variant="outline"
                  className="cursor-default gap-1 font-normal"
                />
              }
            >
              <FileText className="size-3" aria-hidden="true" />[{index + 1}]{" "}
              {source.document_title}
            </TooltipTrigger>
            <TooltipContent className="flex w-64 max-w-xs flex-col items-start gap-0.5 text-left">
              <p className="font-medium">{source.document_title}</p>
              <p className="text-muted-foreground">{source.excerpt}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
