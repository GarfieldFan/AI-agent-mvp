import Link from "next/link";
import { Compass, Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ContactForm } from "@/components/modules/contact-form";

/** The site's own 404 (2026-09-09) — Next.js renders this for both an
 * explicit `notFound()` call (e.g. `/p/[slug]` when that slug has no
 * saved page yet — a site still being staged/built) and any genuinely
 * unmatched route. Deliberately covers both cases with one page and one
 * message: whether a visitor hit a typo/broken link or a page the owner
 * simply hasn't built yet, they still need a way to reach the business
 * — hence the embedded `ContactForm` (independent of the chatbot,
 * `POST /api/contact`) rather than a bare "not found" dead end. */
export default function NotFound() {
  return (
    <Container className="space-y-10 py-12">
      <PageHeader
        title="This page isn't available yet"
        description="The link you followed may be broken, or this part of the site is still being built. In the meantime, here's how to reach us."
      />

      <div className="grid gap-8 md:grid-cols-2">
        <EmptyState
          icon={Compass}
          title="Nothing here (yet)"
          description="Try heading back to the homepage, or send us a message below and we'll get back to you."
          action={
            <Button render={<Link href="/" />} nativeButton={false}>
              <Home className="mr-1.5 h-3.5 w-3.5" />
              Back to homepage
            </Button>
          }
        />
        <ContactForm title="Get in touch" description="Tell us what you were looking for — we'll follow up by email." />
      </div>
    </Container>
  );
}
