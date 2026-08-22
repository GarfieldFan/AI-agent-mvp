import { apiFetch } from "@/lib/api";
import type { Role } from "@/lib/types";

/** Admin/owner-facing user management (2026-08-22, backend/apis/users.py)
 * — listing is admin+owner, every write (create/role-change/delete) is
 * owner-only; the backend re-enforces this on every call regardless of
 * what the UI shows. */
export type ManagedUser = {
  id: number;
  email: string;
  role: Role;
  oauth_provider: string | null;
  email_verified: boolean;
  created_at: string;
};

export type UserListResponse = {
  items: ManagedUser[];
  total: number;
};

export function listUsers(limit = 50, offset = 0) {
  return apiFetch<UserListResponse>(`/api/agent/users?limit=${limit}&offset=${offset}`);
}

export function createUser(input: { email: string; password: string; role: Role }) {
  return apiFetch<ManagedUser>("/api/agent/users", { method: "POST", body: input });
}

export function updateUserRole(userId: number, role: Role) {
  return apiFetch<ManagedUser>(`/api/agent/users/${userId}/role`, { method: "PATCH", body: { role } });
}

export function deleteUser(userId: number) {
  return apiFetch<void>(`/api/agent/users/${userId}`, { method: "DELETE" });
}
