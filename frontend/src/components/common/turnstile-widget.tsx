"use client";

import * as React from "react";
import Script from "next/script";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

type TurnstileWidgetProps = {
  siteKey: string;
  onToken: (token: string) => void;
};

/** Renders a real Cloudflare Turnstile challenge (2026-09-10) — see
 * backend/turnstile.py's own docstring for the full design. Every
 * caller mounts this ONLY once it's already confirmed (via
 * lib/turnstile.ts's getTurnstileConfig) that the owner has actually
 * enabled bot verification — a site with the feature off never loads
 * this script or pays any cost for it at all.
 *
 * Handles both orderings of "is the Cloudflare script already loaded
 * elsewhere on this page" — checks `window.turnstile` synchronously on
 * mount (the common case once a first widget anywhere on the page has
 * already loaded it) and falls back to `next/script`'s own `onLoad` for
 * the first widget on a page. */
export function TurnstileWidget({ siteKey, onToken }: TurnstileWidgetProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const widgetIdRef = React.useRef<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!containerRef.current || !window.turnstile || widgetIdRef.current) return;
    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      callback: onToken,
      "expired-callback": () => onToken(""),
    });
    return () => {
      if (widgetIdRef.current) {
        window.turnstile?.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptLoaded, siteKey]);

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        strategy="lazyOnload"
        onLoad={() => setScriptLoaded(true)}
      />
      <div ref={containerRef} />
    </>
  );
}
