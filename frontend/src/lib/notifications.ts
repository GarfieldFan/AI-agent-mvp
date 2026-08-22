import { apiFetch } from "@/lib/api";

/** Owner-facing email/SMS provider settings (2026-08-20, backend/apis/
 * notifications.py) — same write-only-secret shape as lib/payments.ts's
 * PaymentSettings: `mailgun_api_key`/`twilio_auth_token` are never
 * echoed back, only `*_set` booleans say whether one is saved. Nothing
 * in this app currently sends an email/SMS automatically — these
 * settings and the test-send functions below exist so a provider can be
 * configured and verified ahead of a future business trigger (an order
 * confirmation, a lead notification, ...) that isn't wired up yet. */
export type NotificationSettings = {
  email_provider: "test" | "mailgun";
  mailgun_domain: string | null;
  mailgun_from_address: string | null;
  mailgun_api_key_set: boolean;
  sms_provider: "test" | "twilio";
  twilio_account_sid: string | null;
  twilio_from_number: string | null;
  twilio_auth_token_set: boolean;
};

export type NotificationSettingsInput = {
  email_provider: "test" | "mailgun";
  mailgun_domain?: string | null;
  mailgun_from_address?: string | null;
  /** Omit to leave the previously-saved key alone. */
  mailgun_api_key?: string;
  sms_provider: "test" | "twilio";
  twilio_account_sid?: string | null;
  twilio_from_number?: string | null;
  twilio_auth_token?: string;
};

export function getNotificationSettings() {
  return apiFetch<NotificationSettings>("/api/agent/notification-settings");
}

export function updateNotificationSettings(input: NotificationSettingsInput) {
  return apiFetch<NotificationSettings>("/api/agent/notification-settings", { method: "PUT", body: input });
}

export type TestSendResult = {
  /** Which provider actually handled the send — "test" means nothing
   * was really delivered, so a caller can tell a real send apart from a
   * no-op even though both return 200. */
  provider: string;
};

export function sendTestEmail(to: string) {
  return apiFetch<TestSendResult>("/api/agent/notification-settings/test-email", {
    method: "POST",
    body: { to },
  });
}

export function sendTestSms(to: string) {
  return apiFetch<TestSendResult>("/api/agent/notification-settings/test-sms", {
    method: "POST",
    body: { to },
  });
}
