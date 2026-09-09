"use client";

import * as React from "react";
import { CheckCircle2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorMessage } from "@/components/common/error-message";
import { ApiError } from "@/lib/api";
import { submitContactForm } from "@/lib/contact";

type ContactFormProps = {
  /** Shown above the fields — lets a caller (e.g. `not-found.tsx`) give
   * this generic form page-specific framing without a second component. */
  title?: string;
  description?: string;
  className?: string;
};

/** Plain, no-auth "contact us" form (2026-09-09, `lib/contact.ts`) —
 * independent of the chatbot entirely, for a visitor who lands somewhere
 * with no real content yet (see `app/not-found.tsx`) or who simply
 * prefers a form over chat. Submits directly to `POST /api/contact`,
 * which stores it as a CrmEntry the owner sees in CrmPanel like any
 * other inquiry. */
export function ContactForm({ title, description, className }: ContactFormProps) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    try {
      await submitContactForm({ name, email, message });
      setStatus("sent");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that — please try again shortly.");
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className={className}>
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center">
          <CheckCircle2 className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">Thanks — your message has been sent.</p>
          <p className="text-sm text-muted-foreground">Someone from our team will get back to you soon.</p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      <div className="space-y-4 rounded-xl border p-6">
        {title ? <h2 className="text-lg font-semibold">{title}</h2> : null}
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}

        <div className="space-y-1.5">
          <Label htmlFor="contact-name">Name</Label>
          <Input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-email">Email</Label>
          <Input
            id="contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-message">Message</Label>
          <Textarea
            id="contact-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
            required
          />
        </div>

        <Button type="submit" disabled={status === "sending"}>
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {status === "sending" ? "Sending…" : "Send message"}
        </Button>

        {status === "error" && error ? <ErrorMessage description={error} /> : null}
      </div>
    </form>
  );
}
