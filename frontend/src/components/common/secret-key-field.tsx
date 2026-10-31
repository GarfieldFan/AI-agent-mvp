"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SecretKeyFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Whether the backend already has a value saved (`*_set` flag). */
  saved: boolean;
  /** Example/format hint shown while nothing is saved yet. */
  placeholder: string;
};

/** The write-only credential input every third-party settings panel uses
 * (Stripe/Adyen/Mailgun/Twilio/OAuth/Maps/Turnstile/marketing): a
 * password-type field the backend never echoes back, a "Saved" badge
 * once a value exists, and blank meaning "keep the saved value". Renders
 * a fragment so callers keep their own `space-y-1` wrapper and can put
 * hint text after it. */
export function SecretKeyField({ label, value, onChange, saved, placeholder }: SecretKeyFieldProps) {
  const id = React.useId();
  return (
    <>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={saved ? "•••••••• (leave blank to keep saved key)" : placeholder}
      />
      {saved ? (
        <Badge variant="secondary" className="text-xs">
          Saved
        </Badge>
      ) : null}
    </>
  );
}
