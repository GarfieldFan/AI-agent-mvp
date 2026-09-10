import type { PageSection } from "@/lib/theme";

/** Hand-authored fallback content for the home and about pages, expressed
 * in the same schema a vision-LLM-generated page would use (see
 * lib/theme.ts). This is the "default template" — rendered by
 * SectionRenderer whenever nothing's been saved yet for that slug (see
 * app/page.tsx / app/about/page.tsx), and equally replaceable by a real
 * generated-and-saved page through backend/apis/agent.py's
 * generate_landing_page + lib/pages.ts's savePageVersion. */
export const DEFAULT_HOME_SECTIONS: PageSection[] = [
  {
    type: "hero",
    eyebrow: "AI-native small-business platform",
    headline: "A self-hosted AI stack: RAG, agents, and an agent-permission security boundary",
    subheadline:
      "A small-business website that ships with its own AI employee — a RAG-grounded chatbot, a structured intake/CRM pipeline, and a natural-language owner agent, all behind an explicit permission boundary around what the agent can actually do.",
    ctas: [
      { label: "Chat with the AI assistant", href: "/chat" },
      { label: "About this project", href: "/about", variant: "outline" },
    ],
  },
  {
    type: "feature-grid",
    heading: "Modules",
    subheading: "A few of the pieces this platform ships with.",
    items: [
      {
        href: "/chat",
        icon: "messages-square",
        title: "Chatbot",
        description:
          "Conversational assistant grounded in uploaded documents (RAG, with citations) that falls back to general conversation when nothing's relevant — plus structured lead capture and product ordering.",
      },
      {
        href: "/editor",
        icon: "mouse-pointer-click",
        title: "Click-to-Edit",
        description: "Click any element on a page to edit its text, image, or spacing in place.",
      },
    ],
  },
  {
    type: "text-block",
    icon: "shield-check",
    heading: "Agent security boundary",
    body: "The one component with real LLM tool-calling access (owner-agent) runs as a separate, isolated service — its own container, its own auth check, a fixed tool allowlist, no database connection, no filesystem access. Every action it takes still goes through the same role-based access control as a direct owner request.",
  },
  {
    type: "badge-list",
    heading: "Tech stack",
    badges: [
      "Next.js (App Router)",
      "TypeScript",
      "Tailwind CSS",
      "shadcn/ui",
      "FastAPI",
      "Postgres + pgvector",
      "Ollama",
      "ComfyUI",
      "Docker",
    ],
  },
];

/** Fallback content for the "about" slug — same schema, same
 * never-blank-page reasoning as DEFAULT_HOME_SECTIONS above. */
export const DEFAULT_ABOUT_SECTIONS: PageSection[] = [
  {
    type: "hero",
    eyebrow: "About this project",
    headline: "About this project",
    subheadline: "Background, positioning, and the reasoning behind the technology choices.",
  },
  {
    type: "text-block",
    heading: "Background",
    body: "This project explores what a small business's own website could look like if it shipped with a real AI employee attached — not a chat widget bolted onto a static site, but a chatbot that can actually take structured requests, an editor that lets a non-technical owner reshape any page in place, and an agent that can act on the owner's behalf within an explicit, auditable permission boundary. The technical focus throughout is on getting that boundary right: every AI capability is swappable rather than hardcoded to one vendor, and the one component with real tool-calling access is isolated by construction, not by policy.",
  },
  {
    type: "feature-grid",
    heading: "Design priorities",
    columns: 3,
    items: [
      {
        href: "#",
        title: "Swappable AI providers",
        description: "Chat, vision, embeddings, and image generation each sit behind their own interface — picking a vendor is a dashboard setting, not a rewrite.",
      },
      {
        href: "#",
        title: "Agent isolation by construction",
        description: "The LLM tool-calling loop runs as a separate service with its own auth, no database or filesystem access, and a fixed tool allowlist.",
      },
      {
        href: "#",
        title: "Deterministic where it matters",
        description: "Search, cart totals, and data filtering are plain code — an LLM extracts intent from free text, never computes a total or picks a row out of a prompt-stuffed catalog.",
      },
    ],
  },
  {
    type: "text-block",
    heading: "Why Next.js",
    body: "Most of this project is interactive by nature — user management, the click-to-edit editor, the chatbot, and RAG queries all need client-side state, which doesn't play to a static-site generator's strengths. The App Router covers routing, navigation, and TypeScript integration without assembling that stack by hand.",
  },
  {
    type: "feature-grid",
    heading: "Stack rationale",
    columns: 2,
    items: [
      {
        href: "#",
        title: "RAG over fine-tuning",
        description: "Faster data updates, and every answer stays traceable to a source document.",
      },
      {
        href: "#",
        title: "Postgres + pgvector",
        description: "One database for relational data and vector search, no extra service to run.",
      },
      {
        href: "#",
        title: "Self-issued JWT auth",
        description: "Real bcrypt + JWT, no third-party identity provider — full control over the token lifecycle and role-based access.",
      },
      {
        href: "#",
        title: "Local-first inference",
        description: "Ollama and ComfyUI run on-prem by default; cloud providers (OpenAI, Anthropic, Gemini) are available as a swap-in alternative.",
      },
    ],
  },
];
