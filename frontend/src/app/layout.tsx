import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { SiteJsonLd } from "@/components/layout/site-json-ld";
import { ChatBubbleWidget } from "@/components/modules/chat/chat-bubble-widget";
import { SessionIdBootstrap } from "@/components/modules/session-id-bootstrap";
import { getPublicBusinessProfile } from "@/lib/business-profile";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const FALLBACK_TITLE = "AI MVP";
const FALLBACK_DESCRIPTION =
  "Full-stack + on-prem AI portfolio project: RAG, agent tooling, and an agent-permission security layer.";

/** Dynamic (2026-08-21, was a static `export const metadata`) — once an
 * owner configures a real business profile (BusinessProfilePanel,
 * /dashboard), the site's own title/description reflect their actual
 * business instead of this portfolio project's placeholder copy. Falls
 * back to the original static values with zero configuration, same
 * "sensible default, no forced setup" posture as every other owner
 * setting in this app. A profile-fetch failure degrades to the fallback
 * too — this must never be why the site fails to render. */
export async function generateMetadata(): Promise<Metadata> {
  try {
    const profile = await getPublicBusinessProfile();
    return {
      title: {
        default: profile.business_name || FALLBACK_TITLE,
        template: `%s | ${profile.business_name || FALLBACK_TITLE}`,
      },
      description: profile.business_description || FALLBACK_DESCRIPTION,
    };
  } catch {
    return {
      title: { default: FALLBACK_TITLE, template: `%s | ${FALLBACK_TITLE}` },
      description: FALLBACK_DESCRIPTION,
    };
  }
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <SiteJsonLd />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>
            <SessionIdBootstrap />
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <SiteFooter />
            <ChatBubbleWidget />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
