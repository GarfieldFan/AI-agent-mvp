import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
};

/** Placeholder for "nothing here yet" states — no chat history, no ingested
 * documents, no dashboard data. Also doubles as the module skeleton's
 * "not built yet" card during early development. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center",
        className,
      )}
    >
      {Icon ? <Icon className="size-8 text-muted-foreground" aria-hidden="true" /> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
