import * as React from "react";

import type { Role } from "@/lib/types";

/** Client-side session state for the real login (backend/apis/auth.py).
 * The JWT itself is the source of truth for RBAC — the backend re-decodes
 * and re-verifies it on every request (see backend/apis/deps.py); what's
 * cached here is purely for the UI to know what to show without an extra
 * round trip. Never trust `role`/`email` read from here for anything
 * privileged. */

export type AuthState = {
  token: string | null;
  email: string | null;
  role: Role;
};

const EMPTY_STATE: AuthState = { token: null, email: null, role: "user" };
const STORAGE_KEY = "auth";
const CHANGE_EVENT = "auth-change";

function parseState(raw: string | null): AuthState {
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (typeof parsed.token === "string") {
      return {
        token: parsed.token,
        email: typeof parsed.email === "string" ? parsed.email : null,
        role: parsed.role === "admin" || parsed.role === "owner" ? parsed.role : "user",
      };
    }
  } catch {
    // fall through to EMPTY_STATE
  }
  return EMPTY_STATE;
}

// useSyncExternalStore requires getSnapshot to return the *same reference*
// when nothing's changed — parseState() builds a fresh object every call,
// so calling it unconditionally caused an "infinite loop" warning (React
// saw a "new" snapshot on every render even when localStorage hadn't
// changed). Caching by the raw string is what actually fixes that: same
// raw value in → same AuthState object back out.
let cachedRaw: string | null = null;
let cachedState: AuthState = EMPTY_STATE;

function readStorage(): AuthState {
  if (typeof window === "undefined") return EMPTY_STATE;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedState = parseState(raw);
  }
  return cachedState;
}

export function getAuthState(): AuthState {
  return readStorage();
}

/** Just the token — this is the one `lib/api.ts` actually needs on every
 * request; kept separate so callers that only need it don't have to parse
 * the whole state object. */
export function getAuthToken(): string | null {
  return readStorage().token;
}

export function setAuth(state: { token: string; email: string; role: Role }) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearAuth() {
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** Reactive read of the current auth state — re-renders the caller
 * whenever `setAuth`/`clearAuth` is called anywhere in the app (or login/
 * logout happens in another tab). */
export function useAuth(): AuthState {
  return React.useSyncExternalStore(subscribe, getAuthState, () => EMPTY_STATE);
}
