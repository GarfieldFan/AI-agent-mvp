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
