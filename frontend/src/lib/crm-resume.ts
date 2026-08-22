import { apiFetch } from "@/lib/api";
import { getChatSessionId } from "@/lib/chat";

/** Cross-session CRM entry recovery via an emailed one-time code
 * (2026-08-20, backend/apis/crm_resume.py) — lets a visitor who
 * abandoned a multi-turn structured intake (an insurance claim
 * mid-fill, say) in one browser session pick it back up in this one.
 * Deliberately independent of the chat/LLM layer entirely — both calls
 * below are plain REST, never routed through a chat turn. No
 * `schema_key` needed — the backend resumes the visitor's own most
 * recent schema-linked request, across whichever kind it was. */

export type ResumeRequestResult = {
  message: string;
};

/** Always returns the same generic message whether or not a matching
 * request was found — a response that differed would let anyone probe
 * "does this email have a request on file," see the backend's own
 * enumeration-avoidance reasoning. */
export function requestResumeCode(contactEmail: string) {
  return apiFetch<ResumeRequestResult>("/api/crm/resume/request", {
    method: "POST",
    body: { contact_email: contactEmail },
  });
}

export type ResumeVerifyResult = {
  resumed: boolean;
  collected_fields: Record<string, string> | null;
};

/** On success, the backend rebinds the found entry to THIS browser's own
 * session id (getChatSessionId()) — no further action needed here; the
 * very next chat turn in this same session automatically sees the
 * resumed entry via apis/chat.py's existing `_find_active_entry`. */
export function verifyResumeCode(contactEmail: string, code: string) {
  return apiFetch<ResumeVerifyResult>("/api/crm/resume/verify", {
    method: "POST",
    body: { contact_email: contactEmail, code, session_id: getChatSessionId() },
  });
}
