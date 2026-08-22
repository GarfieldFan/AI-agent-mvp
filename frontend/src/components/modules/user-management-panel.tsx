"use client";

import * as React from "react";
import { Trash2, UserPlus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { Pagination } from "@/components/common/pagination";
import { RoleBadge } from "@/components/common/role-badge";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import type { Role } from "@/lib/types";
import { createUser, deleteUser, listUsers, updateUserRole, type ManagedUser } from "@/lib/users";

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "user", label: "User" },
];

const PAGE_SIZE = 20;

/** Owner-facing user/role management (2026-08-22, backend/apis/users.py)
 * — listing is admin+owner-viewable (the same read bar most panels in
 * this section already use), every write (create/role-change/delete) is
 * owner-only, re-enforced server-side regardless of what this UI shows.
 * An admin viewing this panel sees a read-only list; an owner sees the
 * full create form + per-row role picker + delete. The backend's own
 * safety guards (can't touch your own account, can't leave zero owners)
 * are also mirrored here client-side (disabled controls on your own row)
 * purely as a UX nicety — the real enforcement is server-side. */
export function UserManagementPanel() {
  const { email: currentEmail, role: currentRole } = useAuth();
  const isOwner = currentRole === "owner";

  const [users, setUsers] = React.useState<ManagedUser[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [listError, setListError] = React.useState<string | null>(null);

  const [showCreate, setShowCreate] = React.useState(false);
  const [newEmail, setNewEmail] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [newRole, setNewRole] = React.useState<Role>("user");
  const [createStatus, setCreateStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [createError, setCreateError] = React.useState<string | null>(null);

  const [roleUpdatingId, setRoleUpdatingId] = React.useState<number | null>(null);
  const [rowErrorById, setRowErrorById] = React.useState<Record<number, string>>({});
  const [deletingId, setDeletingId] = React.useState<number | null>(null);

  const refresh = React.useCallback(() => {
    listUsers(PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .then((result) => {
        setUsers(result.items);
        setTotal(result.total);
        setListError(null);
      })
      .catch((err) => setListError(err instanceof ApiError ? err.message : "Failed to load users."));
  }, [page]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleCreate() {
    if (!newEmail.trim() || !newPassword) return;
    setCreateStatus("saving");
    setCreateError(null);
    try {
      await createUser({ email: newEmail.trim(), password: newPassword, role: newRole });
      setNewEmail("");
      setNewPassword("");
      setNewRole("user");
      setShowCreate(false);
      setCreateStatus("idle");
      setPage(1);
      refresh();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Create failed — is the backend reachable?");
      setCreateStatus("error");
    }
  }

  async function handleRoleChange(user: ManagedUser, role: Role) {
    if (role === user.role) return;
    setRoleUpdatingId(user.id);
    setRowErrorById((prev) => ({ ...prev, [user.id]: "" }));
    try {
      const updated = await updateUserRole(user.id, role);
      setUsers((prev) => (prev ? prev.map((u) => (u.id === user.id ? updated : u)) : prev));
    } catch (err) {
      setRowErrorById((prev) => ({
        ...prev,
        [user.id]: err instanceof ApiError ? err.message : "Role change failed.",
      }));
    } finally {
      setRoleUpdatingId(null);
    }
  }

  async function handleDelete(user: ManagedUser) {
    if (!window.confirm(`Delete ${user.email}? This can't be undone.`)) return;
    setDeletingId(user.id);
    setRowErrorById((prev) => ({ ...prev, [user.id]: "" }));
    try {
      await deleteUser(user.id);
      if (users && users.length === 1 && page > 1) {
        setPage(page - 1);
      } else {
        refresh();
      }
    } catch (err) {
      setRowErrorById((prev) => ({
        ...prev,
        [user.id]: err instanceof ApiError ? err.message : "Delete failed.",
      }));
    } finally {
      setDeletingId(null);
    }
  }

  if (listError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={listError} onRetry={refresh} />
      </div>
    );
  }

  if (!users) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading users…" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="h-4 w-4" />
            Users
          </h3>
          <p className="text-xs text-muted-foreground">
            Every account in the system. {isOwner ? "Role changes and account creation/deletion are owner-only." : "Only an owner can create accounts, change roles, or delete a user — you can view this list as an admin."}
          </p>
        </div>
        {isOwner ? (
          <Button size="sm" variant="outline" onClick={() => setShowCreate((v) => !v)}>
            <UserPlus className="h-4 w-4" />
            New user
          </Button>
        ) : null}
      </div>

      {isOwner && showCreate ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Email</Label>
            <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="new-hire@example.com" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Password</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Role</Label>
            <Select value={newRole} onValueChange={(v) => v && setNewRole(v as Role)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleCreate} disabled={!newEmail.trim() || !newPassword || createStatus === "saving"}>
              {createStatus === "saving" ? "Creating…" : "Create user"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
          {createStatus === "error" && createError ? (
            <ErrorMessage description={createError} onRetry={() => setCreateStatus("idle")} />
          ) : null}
        </div>
      ) : null}

      {users.length === 0 ? (
        <EmptyState title="No users" description="Nothing to show yet." />
      ) : (
        <div className="space-y-2">
          {users.map((user) => {
            const isSelf = user.email === currentEmail;
            return (
              <div key={user.id} className="space-y-1 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      {user.email} {isSelf ? <span className="text-xs text-muted-foreground">(you)</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {user.oauth_provider ? `Signed in via ${user.oauth_provider}` : "Password login"} ·{" "}
                      {new Date(user.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isOwner ? (
                      <Select
                        value={user.role}
                        onValueChange={(v) => v && handleRoleChange(user, v as Role)}
                        disabled={isSelf || roleUpdatingId === user.id}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <RoleBadge role={user.role} />
                    )}
                    {isOwner ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={isSelf || deletingId === user.id}
                        onClick={() => handleDelete(user)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                {rowErrorById[user.id] ? <p className="text-xs text-destructive">{rowErrorById[user.id]}</p> : null}
              </div>
            );
          })}
        </div>
      )}

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
    </div>
  );
}
