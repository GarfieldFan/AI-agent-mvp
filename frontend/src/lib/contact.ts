import { apiFetch } from "@/lib/api";

/** Public "contact us" form (2026-09-09, backend/apis/contact.py) — a
 * plain, no-auth way for a visitor to reach the business directly,
 * independent of the chatbot's own automatic lead capture. Stores as a
 * CrmEntry (category "inquiry", tags ["contact-form"]) — shows up in
 * CrmPanel's existing "Inquiries" group with no new dashboard UI. */
export function submitContactForm(input: { name: string; email: string; message: string }) {
  return apiFetch<{ ok: boolean }>("/api/contact", {
    method: "POST",
    body: input,
  });
}
