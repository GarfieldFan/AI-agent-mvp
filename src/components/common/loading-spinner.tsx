import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

type LoadingSpinnerProps = {
  label?: string;
  className?: string;
};

/** Inline loading indicator — drop into a button, a card body, or a full
 * section while a query/mutation against the FastAPI backend is in flight. */
export function LoadingSpinner({ label, className }: LoadingSpinnerProps) {
  return (
    <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>{label ?? "Loading…"}</span>
    </div>
  );
}
