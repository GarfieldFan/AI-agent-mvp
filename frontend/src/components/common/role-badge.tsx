import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/types";

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  user: "User",
};

const ROLE_CLASS: Record<Role, string> = {
  owner: "border-transparent bg-primary text-primary-foreground",
  admin: "border-transparent bg-secondary text-secondary-foreground",
  user: "text-muted-foreground",
};

type RoleBadgeProps = {
  role: Role;
  className?: string;
};

/** Renders an RBAC role as a badge. This is a UI convenience only — the
 * backend re-checks the role on every request, it is never trusted just
 * because the frontend hid or showed something based on it. */
export function RoleBadge({ role, className }: RoleBadgeProps) {
  return (
    <Badge variant="outline" className={cn(ROLE_CLASS[role], className)}>
      {ROLE_LABEL[role]}
    </Badge>
  );
}
