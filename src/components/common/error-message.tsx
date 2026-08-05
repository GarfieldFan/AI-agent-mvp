import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type ErrorMessageProps = {
  title?: string;
  description: string;
  onRetry?: () => void;
  className?: string;
};

/** Standard failure state for a failed API call — pair with `onRetry` when
 * the caller can re-run the request (e.g. a RAG query or chat send). */
export function ErrorMessage({ title = "Something went wrong", description, onRetry, className }: ErrorMessageProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div>
          <p className="font-medium text-destructive">{title}</p>
          <p className="text-muted-foreground">{description}</p>
        </div>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
