"use client";

import * as React from "react";
import { Mail, MessageSquare, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorMessage } from "@/components/common/error-message";
import { LoadingSpinner } from "@/components/common/loading-spinner";
import { ApiError } from "@/lib/api";
import {
  getNotificationSettings,
  sendTestEmail,
  sendTestSms,
  updateNotificationSettings,
  type NotificationSettings,
} from "@/lib/notifications";

const EMAIL_PROVIDER_OPTIONS = [
  { value: "test" as const, label: "Test mode (no real send)" },
  { value: "mailgun" as const, label: "Mailgun" },
];

const SMS_PROVIDER_OPTIONS = [
  { value: "test" as const, label: "Test mode (no real send)" },
  { value: "twilio" as const, label: "Twilio" },
];

/** Owner-facing email/SMS provider picker (2026-08-20, backend/apis/
 * notifications.py) — mirrors PaymentSettingsPanel's write-only-secret
 * UX exactly, applied to two more capability domains. Nothing in this
 * app sends an email/SMS automatically yet (see backend/notifications.py's
 * own docstring) — this panel exists so a provider can be configured
 * and proven to work (the "Send test email"/"Send test SMS" buttons)
 * ahead of whatever business trigger eventually uses it. */
export function NotificationSettingsPanel() {
  const [settings, setSettings] = React.useState<NotificationSettings | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [emailProvider, setEmailProvider] = React.useState<"test" | "mailgun">("test");
  const [mailgunDomain, setMailgunDomain] = React.useState("");
  const [mailgunFromAddress, setMailgunFromAddress] = React.useState("");
  const [mailgunApiKeyInput, setMailgunApiKeyInput] = React.useState("");

  const [smsProvider, setSmsProvider] = React.useState<"test" | "twilio">("test");
  const [twilioAccountSid, setTwilioAccountSid] = React.useState("");
  const [twilioFromNumber, setTwilioFromNumber] = React.useState("");
  const [twilioAuthTokenInput, setTwilioAuthTokenInput] = React.useState("");

  const [alertEmail, setAlertEmail] = React.useState("");

  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const [testEmailTo, setTestEmailTo] = React.useState("");
  const [testEmailStatus, setTestEmailStatus] = React.useState<"idle" | "sending" | "error">("idle");
  const [testEmailError, setTestEmailError] = React.useState<string | null>(null);
  const [testEmailResult, setTestEmailResult] = React.useState<string | null>(null);

  const [testSmsTo, setTestSmsTo] = React.useState("");
  const [testSmsStatus, setTestSmsStatus] = React.useState<"idle" | "sending" | "error">("idle");
  const [testSmsError, setTestSmsError] = React.useState<string | null>(null);
  const [testSmsResult, setTestSmsResult] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    getNotificationSettings()
      .then((result) => {
        setSettings(result);
        setEmailProvider(result.email_provider);
        setMailgunDomain(result.mailgun_domain ?? "");
        setMailgunFromAddress(result.mailgun_from_address ?? "");
        setSmsProvider(result.sms_provider);
        setTwilioAccountSid(result.twilio_account_sid ?? "");
        setTwilioFromNumber(result.twilio_from_number ?? "");
        setAlertEmail(result.alert_email ?? "");
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load notification settings."));
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const result = await updateNotificationSettings({
        email_provider: emailProvider,
        mailgun_domain: mailgunDomain.trim() || null,
        mailgun_from_address: mailgunFromAddress.trim() || null,
        ...(mailgunApiKeyInput.trim() ? { mailgun_api_key: mailgunApiKeyInput.trim() } : {}),
        sms_provider: smsProvider,
        twilio_account_sid: twilioAccountSid.trim() || null,
        twilio_from_number: twilioFromNumber.trim() || null,
        ...(twilioAuthTokenInput.trim() ? { twilio_auth_token: twilioAuthTokenInput.trim() } : {}),
        alert_email: alertEmail.trim() || null,
      });
      setSettings(result);
      setMailgunApiKeyInput("");
      setTwilioAuthTokenInput("");
      setSaveStatus("idle");
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Save failed — is the backend reachable?");
      setSaveStatus("error");
    }
  }

  async function handleTestEmail() {
    if (!testEmailTo.trim()) return;
    setTestEmailStatus("sending");
    setTestEmailError(null);
    setTestEmailResult(null);
    try {
      const result = await sendTestEmail(testEmailTo.trim());
      setTestEmailResult(result.provider);
      setTestEmailStatus("idle");
    } catch (err) {
      setTestEmailError(err instanceof ApiError ? err.message : "Send failed — is the backend reachable?");
      setTestEmailStatus("error");
    }
  }

  async function handleTestSms() {
    if (!testSmsTo.trim()) return;
    setTestSmsStatus("sending");
    setTestSmsError(null);
    setTestSmsResult(null);
    try {
      const result = await sendTestSms(testSmsTo.trim());
      setTestSmsResult(result.provider);
      setTestSmsStatus("idle");
    } catch (err) {
      setTestSmsError(err instanceof ApiError ? err.message : "Send failed — is the backend reachable?");
      setTestSmsStatus("error");
    }
  }

  if (loadError) {
    return (
      <div className="rounded-xl border p-4">
        <ErrorMessage description={loadError} onRetry={refresh} />
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="rounded-xl border p-4">
        <LoadingSpinner label="Loading notification settings…" />
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Email &amp; SMS</h3>
        <p className="text-xs text-muted-foreground">
          Configures the providers a future automated send (an order confirmation, a lead
          notification, ...) would use — nothing in this app sends automatically yet. Test mode is
          the default: nothing is ever really delivered.
        </p>
      </div>

      <div className="space-y-3">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Mail className="h-4 w-4" />
          Email
        </h4>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Provider</Label>
          <Select value={emailProvider} onValueChange={(v) => v && setEmailProvider(v as "test" | "mailgun")}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EMAIL_PROVIDER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {emailProvider === "mailgun" ? (
          <div className="space-y-3 rounded-lg border border-dashed p-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Domain</Label>
              <Input value={mailgunDomain} onChange={(e) => setMailgunDomain(e.target.value)} placeholder="mg.example.com" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From address</Label>
              <Input
                value={mailgunFromAddress}
                onChange={(e) => setMailgunFromAddress(e.target.value)}
                placeholder="noreply@mg.example.com"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">API key</Label>
              <Input
                type="password"
                value={mailgunApiKeyInput}
                onChange={(e) => setMailgunApiKeyInput(e.target.value)}
                placeholder={settings.mailgun_api_key_set ? "•••••••• (leave blank to keep saved key)" : "key-…"}
              />
              {settings.mailgun_api_key_set ? (
                <Badge variant="secondary" className="text-xs">
                  Saved
                </Badge>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={testEmailTo}
            onChange={(e) => setTestEmailTo(e.target.value)}
            placeholder="you@example.com"
            className="w-64"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestEmail}
            disabled={!testEmailTo.trim() || testEmailStatus === "sending"}
          >
            {testEmailStatus === "sending" ? "Sending…" : "Send test email"}
          </Button>
          {testEmailResult ? (
            <span className="text-xs text-muted-foreground">
              Sent via <code>{testEmailResult}</code>{testEmailResult === "test" ? " (nothing really delivered)" : ""}
            </span>
          ) : null}
        </div>
        {testEmailStatus === "error" && testEmailError ? (
          <ErrorMessage description={testEmailError} onRetry={() => setTestEmailStatus("idle")} />
        ) : null}
      </div>

      <div className="space-y-3 border-t pt-4">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <MessageSquare className="h-4 w-4" />
          SMS
        </h4>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Provider</Label>
          <Select value={smsProvider} onValueChange={(v) => v && setSmsProvider(v as "test" | "twilio")}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SMS_PROVIDER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {smsProvider === "twilio" ? (
          <div className="space-y-3 rounded-lg border border-dashed p-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Account SID</Label>
              <Input value={twilioAccountSid} onChange={(e) => setTwilioAccountSid(e.target.value)} placeholder="AC…" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From number</Label>
              <Input
                value={twilioFromNumber}
                onChange={(e) => setTwilioFromNumber(e.target.value)}
                placeholder="+15555550100"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Auth token</Label>
              <Input
                type="password"
                value={twilioAuthTokenInput}
                onChange={(e) => setTwilioAuthTokenInput(e.target.value)}
                placeholder={settings.twilio_auth_token_set ? "•••••••• (leave blank to keep saved key)" : "…"}
              />
              {settings.twilio_auth_token_set ? (
                <Badge variant="secondary" className="text-xs">
                  Saved
                </Badge>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={testSmsTo}
            onChange={(e) => setTestSmsTo(e.target.value)}
            placeholder="+15555550100"
            className="w-64"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestSms}
            disabled={!testSmsTo.trim() || testSmsStatus === "sending"}
          >
            {testSmsStatus === "sending" ? "Sending…" : "Send test SMS"}
          </Button>
          {testSmsResult ? (
            <span className="text-xs text-muted-foreground">
              Sent via <code>{testSmsResult}</code>{testSmsResult === "test" ? " (nothing really delivered)" : ""}
            </span>
          ) : null}
        </div>
        {testSmsStatus === "error" && testSmsError ? (
          <ErrorMessage description={testSmsError} onRetry={() => setTestSmsStatus("idle")} />
        ) : null}
      </div>

      <div className="space-y-3 border-t pt-4">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="h-4 w-4" />
          Error alerts
        </h4>
        <p className="text-xs text-muted-foreground">
          Where an automatic alert goes when the backend hits a genuinely unhandled error (a crash, not
          a routine 4xx). Reuses the email provider configured above — no separate credential needed.
          Leave blank to disable alerting.
        </p>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Alert email</Label>
          <Input
            type="email"
            value={alertEmail}
            onChange={(e) => setAlertEmail(e.target.value)}
            placeholder="owner@example.com"
            className="w-64"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 border-t pt-4">
        <Button onClick={handleSave} disabled={saveStatus === "saving"}>
          {saveStatus === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>
      {saveStatus === "error" && saveError ? (
        <ErrorMessage description={saveError} onRetry={() => setSaveStatus("idle")} />
      ) : null}
    </div>
  );
}
