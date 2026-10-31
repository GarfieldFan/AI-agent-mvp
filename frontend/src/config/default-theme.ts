import type { PageSection } from "@/lib/theme";

/** The system's own bottom-layer landing page — the equivalent of a
 * WordPress default theme. Rendered by app/page.tsx only while no "home"
 * page has been saved yet; a real generated/edited-and-saved page through
 * PageGeneratorPanel or /editor replaces it entirely. Deliberately
 * neutral, visitor-facing copy (no platform/tech-stack marketing) since a
 * real business's visitors may see it before the owner customizes
 * anything. Uses the configured business name/description when present.
 *
 * There is intentionally no default "about" page anymore — /about only
 * exists once an admin/owner saves one (see app/about/page.tsx).
 *
 * `#chat` CTAs open the site-wide ChatBubbleWidget instead of navigating
 * (see that component's click handler) — the chatbot is system-level, not
 * a page. */
export function buildDefaultHomeSections(profile?: {
  business_name: string | null;
  business_description: string | null;
}): PageSection[] {
  const name = profile?.business_name?.trim();
  const description = profile?.business_description?.trim();

  return [
    {
      type: "hero",
      eyebrow: name ? "Welcome" : undefined,
      headline: name ? `Welcome to ${name}` : "Welcome to our new website",
      subheadline:
        description ||
        "We're just getting started here. Have a question, want a quote, or need to book something? Our assistant is available any time.",
      ctas: [
        { label: "Chat with us", href: "#chat" },
        { label: "Browse products", href: "/search", variant: "outline" },
      ],
    },
    {
      type: "feature-grid",
      heading: "How we can help",
      columns: 3,
      items: [
        {
          href: "#chat",
          icon: "messages-square",
          title: "Ask a question",
          description: "Get an answer right away from our assistant, day or night.",
        },
        {
          href: "#chat",
          icon: "calendar",
          title: "Make a request",
          description: "Book an appointment, request a quote, or send us the details of what you need.",
        },
        {
          href: "/search",
          icon: "shopping-bag",
          title: "Shop",
          description: "Browse what we offer and add items to your cart.",
        },
      ],
    },
    {
      type: "cta-banner",
      heading: "Not sure where to start?",
      body: "Tell us what you're looking for and we'll point you in the right direction.",
      ctas: [{ label: "Start a conversation", href: "#chat" }],
    },
  ];
}
