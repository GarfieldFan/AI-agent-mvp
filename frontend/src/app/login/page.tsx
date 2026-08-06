import type { Metadata } from "next";

import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { LoginForm } from "@/components/modules/login-form";

export const metadata: Metadata = {
  title: "Log in",
  description: "Sign in to access the admin/owner dashboard.",
};

export default function LoginPage() {
  return (
    <Container className="max-w-sm space-y-8 py-16">
      <PageHeader title="Log in" description="Real JWT-based auth — see backend/apis/auth.py." />
      <LoginForm />
    </Container>
  );
}
