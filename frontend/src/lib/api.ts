import { getAuthToken } from "@/lib/auth";

/** Base URL of the FastAPI backend (see ../../docker-compose.yml).
 *
 * Two different networks reach the backend, and they need two different
 * URLs — this bit us once building the DB-backed pages feature:
 *  - The **browser** calls it from the host machine, where docker-compose
 *    publishes the backend's port to `localhost:8000`.
 *  - **Server Components** run inside the frontend *container*, where
 *    `localhost:8000` means the frontend container's own (unused) port
 *    8000, not the backend's — they need the backend's docker-compose
 *    *service name* (`http://backend:8000`, resolved via Docker's internal
 *    DNS) instead.
 *
 * `typeof window` is reliably `"undefined"` in every server-side bundle
 * and defined in every browser bundle, so this is safe as a module-level
 * constant — no need to re-check per call. */
const API_BASE_URL =
  typeof window === "undefined"
    ? (process.env.INTERNAL_API_URL ?? "http://backend:8000")
    : (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000");

/** FastAPI's `detail` field is usually a plain string (every
 * `HTTPException(..., detail="...")` in this backend), but a 422 from
 * Pydantic's own request-body validation (e.g. a missing/mistyped field
 * — a stale frontend bundle sending an old payload shape is the classic
 * trigger) sends `detail` as a *list* of `{loc, msg, type}` objects
 * instead. Passed through unhandled, that array/object ends up as
 * `ApiError.message` (typed `string`, but not actually one at runtime)
 * and renders as a bare "[object Object]" wherever a component displays
 * it — this normalizes both shapes into an actual readable string. */
function extractErrorMessage(errorBody: unknown, fallback: string): string {
  const detail = (errorBody as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry) => {
        if (!entry || typeof entry !== "object" || !("msg" in entry)) return null;
        const msg = String((entry as { msg: unknown }).msg);
        const loc = "loc" in entry && Array.isArray((entry as { loc: unknown }).loc)
          ? (entry as { loc: unknown[] }).loc.join(".")
          : null;
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter((m): m is string => !!m);
    if (messages.length > 0) return messages.join("; ");
  }
  return fallback;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type ApiFetchOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  /** Overrides the stored session token for this one call. Almost never
   * needed — apiFetch already attaches the logged-in user's token (see
   * lib/auth.ts) automatically. */
  token?: string;
};

/** Thin fetch wrapper around the FastAPI backend: resolves the base URL,
 * serializes JSON bodies, attaches an auth header when given a token, and
 * normalizes non-2xx responses into a thrown `ApiError`. Every module's
 * API calls should go through this instead of calling `fetch` directly. */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, token, headers, ...rest } = options;
  const authToken = token ?? getAuthToken();

  const response = await fetch(`${API_BASE_URL}${path}`, {
    // Next.js patches fetch() in Server Components with its own cache,
    // which held onto a stale 404 here even under `export const dynamic =
    // "force-dynamic"` on the page — explicit no-store is what actually
    // guarantees a fresh request every time. Callers can still override
    // via `rest` below (e.g. a page that genuinely wants caching).
    cache: "no-store",
    ...rest,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => undefined);
    throw new ApiError(response.status, extractErrorMessage(errorBody, response.statusText), errorBody);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
