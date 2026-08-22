"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ErrorMessage } from "@/components/common/error-message";
import { apiFetch, ApiError } from "@/lib/api";
import { setAuth } from "@/lib/auth";
import { getOAuthProviders, googleOAuthStartUrl, facebookOAuthStartUrl, xOAuthStartUrl, type OAuthProviders } from "@/lib/oauth";

type MeResponse = { email: string; role: "owner" | "admin" | "user" };

type LoginResponse = {
  access_token: string;
  token_type: string;
  email: string;
  role: "owner" | "admin" | "user";
};

/** Real login (backend/apis/auth.py) — replaces the old dev role
 * switcher. Demo scope: three seeded accounts (see backend/seed.py),
 * shown below so anyone running the demo can log in without digging
 * through the backend — there's nothing behind these accounts worth
 * protecting in a local docker-compose demo. */
export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [oauthProviders, setOauthProviders] = React.useState<OAuthProviders>({ google: false, facebook: false, x: false });

  React.useEffect(() => {
    getOAuthProviders()
      .then(setOauthProviders)
      .catch(() => setOauthProviders({ google: false, facebook: false, x: false }));
  }, []);

  // Picks up the redirect back from any provider's own consent screen
  // (see backend/apis/oauth.py's callbacks — same "?param=..., frontend
  // bootstraps and strips it" pattern as session-id-bootstrap.tsx's
  // `?sid=`, scoped to this page only since OAuth only ever completes
  // here). Only the token comes back on the URL — email/role are
  // resolved via GET /auth/me with that token, not stuffed into the URL
  // too, so a bookmarked/shared login link can't accidentally leak a
  // readable profile summary alongside the token.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("oauth_token");
    const oauthError = params.get("oauth_error");
    if (!token && !oauthError) return;
    window.history.replaceState(null, "", window.location.pathname);

    // Resolves through a promise chain even for the immediate-error case
    // (never a bare synchronous setState call in the effect body) — trips
    // react-hooks/set-state-in-effect otherwise, same class of fix already
    // applied elsewhere in this app (MapBlock, ChatSessionViewerPanel).
    async function finishOAuthLogin(): Promise<void> {
      setStatus("loading");
      if (oauthError || !token) throw new Error("oauth_error");
      const me = await apiFetch<MeResponse>("/api/auth/me", { token });
      setAuth({ token, email: me.email, role: me.role });
      router.push("/dashboard");
    }
    finishOAuthLogin().catch(() => {
      setError("Social sign-in failed — please try again.");
      setStatus("error");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("loading");
    setError(null);
    try {
      const response = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setAuth({ token: response.access_token, email: response.email, role: response.role });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed — is the backend reachable?");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            disabled={status === "loading"}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={status === "loading"}
          />
        </div>

        <Button type="submit" disabled={status === "loading"} className="w-full">
          <LogIn className="size-4" />
          Log in
        </Button>

        {status === "loading" ? <LoadingSpinner label="Logging in…" /> : null}
        {status === "error" && error ? (
          <ErrorMessage description={error} onRetry={() => setStatus("idle")} />
        ) : null}
      </form>

      {oauthProviders.google || oauthProviders.facebook || oauthProviders.x ? (
        <div className="space-y-2">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">Or</span>
            </div>
          </div>
          {oauthProviders.google ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              render={<a href={googleOAuthStartUrl()} />}
              nativeButton={false}
            >
              Sign in with Google
            </Button>
          ) : null}
          {oauthProviders.facebook ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              render={<a href={facebookOAuthStartUrl()} />}
              nativeButton={false}
            >
              Sign in with Facebook
            </Button>
          ) : null}
          {oauthProviders.x ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              render={<a href={xOAuthStartUrl()} />}
              nativeButton={false}
            >
              Sign in with X
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Demo accounts (password: 0000)</p>
        <ul className="mt-1 space-y-0.5">
          <li>owner@example.com</li>
          <li>admin@example.com</li>
          <li>user@example.com</li>
        </ul>
      </div>
    </div>
  );
}
