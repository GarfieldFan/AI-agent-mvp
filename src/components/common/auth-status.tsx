"use client";

import Link from "next/link";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RoleBadge } from "@/components/common/role-badge";
import { useAuth, clearAuth } from "@/lib/auth";

/** Header auth widget — replaced the temporary `DevRoleSwitcher` once real
 * login shipped (backend/apis/auth.py). Logged out: a "Log in" link.
 * Logged in: email + `RoleBadge` + Log out. Purely a UI convenience —
 * every privileged backend route re-verifies the JWT itself regardless of
 * what this shows (see backend/apis/deps.py). */
export function AuthStatus() {
  const { token, email, role } = useAuth();

  if (!token) {
    return (
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/login" />}>
        Log in
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-sm text-muted-foreground sm:inline">{email}</span>
      <RoleBadge role={role} />
      <Button variant="ghost" size="icon" aria-label="Log out" onClick={clearAuth}>
        <LogOut className="size-4" />
      </Button>
    </div>
  );
}
