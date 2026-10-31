"use client";

import Link from "next/link";
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import { useAuth } from "@/lib/auth";

/** Shown above the system default landing page, to admin/owner only —
 * the equivalent of WordPress telling a logged-in admin "this is the
 * default theme." Visitors never see it. */
export function DefaultHomeAdminNotice() {
  const { token, role } = useAuth();
  if (!token || (role !== "admin" && role !== "owner")) return null;

  return (
    <Container className="pt-6">
      <div className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/40 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-2 text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          You&apos;re seeing the system default landing page — no &quot;home&quot; page has been saved yet. Only admins and owners see this notice.
        </p>
        <Button size="sm" nativeButton={false} render={<Link href="/dashboard?section=content&item=page-generator" />}>
          Create your homepage
        </Button>
      </div>
    </Container>
  );
}
