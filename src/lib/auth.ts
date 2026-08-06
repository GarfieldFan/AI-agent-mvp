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

/** Reads the token's own "exp" claim client-side — the backend never
 * hard-401s on an expired/invalid token (see apis/deps.py's docstring:
 * it silently downgrades to the anonymous `user` role instead, since the
 * public chatbot needs to keep working with no token at all), so there's
 * no server response to react to here. A malformed/undecodable token is
 * treated as expired too — same "assume the worst" default. */
function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp !== "number" || Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

/** Pure — this backs `useAuth()`'s `useSyncExternalStore` snapshot, which
 * must never mutate anything (see the class comment above `cachedRaw` for
 * the "infinite loop" bug that purity violation caused once already).
 * Actually clearing an expired token's storage happens in `getAuthToken()`
 * below, not here. */
export function getAuthState(): AuthState {
  const state = readStorage();
  if (state.token && isTokenExpired(state.token)) return EMPTY_STATE;
  return state;
}

/** Just the token — this is the one `lib/api.ts` actually needs on every
 * request; kept separate so callers that only need it don't have to parse
 * the whole state object.
 *
 * **Also where session expiry actually gets acted on**: found from a real
 * report — after a token expired, admin-only sections correctly started
 * 403ing (the backend already did this right), but the header's login
 * widget kept showing the old logged-in user indefinitely, since nothing
 * ever cleared the stale localStorage entry. `apiFetch` calls this on
 * every single request to build the Authorization header, so it's a
 * side-effect-safe place (outside any render) to detect expiry and call
 * the real `clearAuth()` — which removes the stored session *and* fires
 * the change event every `useAuth()` subscriber (including the header's
 * `AuthStatus`) is listening for, so the UI updates as part of the very
 * request that would have 403'd anyway, not on some later unrelated
 * render. */
export function getAuthToken(): string | null {
  const state = readStorage();
  if (state.token && isTokenExpired(state.token)) {
    clearAuth();
    return null;
  }
  return state.token;
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
