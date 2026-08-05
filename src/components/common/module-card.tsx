import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

type ModuleCardProps = {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  status?: "live" | "planned";
};

/** One tile in the landing page's module grid — also reusable anywhere
 * else a module needs a compact "what is this, go here" entry point. */
export function ModuleCard({ href, icon: Icon, title, description, status = "live" }: ModuleCardProps) {
  return (
    <Link href={href} className="group block">
      <Card className="h-full transition-colors group-hover:bg-muted/40">
        <CardHeader>
          <div className="flex items-center justify-between">
            <Icon className="size-6 text-primary" aria-hidden="true" />
            {status === "planned" ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Planned
              </span>
            ) : null}
          </div>
          <CardTitle className="flex items-center gap-1">
            {title}
            <ArrowRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
