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
    eyebrow: "Full-stack + on-prem AI portfolio project",
    headline: "A self-hosted AI stack: RAG, agents, and agent-permission security",
    subheadline:
      "Five years of full-stack (PHP/SQL) experience applied to a local-first AI application — document Q&A, a structured-output chatbot, and an explicit permission boundary around agent tooling.",
    ctas: [
      { label: "Chat with the AI assistant", href: "/chat" },
      { label: "About this project", href: "/about", variant: "outline" },
    ],
  },
  {
    type: "feature-grid",
    heading: "Modules",
    subheading: "Each module below maps to a section of the project plan.",
    items: [
      {
        href: "/chat",
        icon: "messages-square",
        title: "Chatbot",
        description:
          "Conversational assistant grounded in uploaded documents (RAG, with citations) that falls back to general conversation when nothing's relevant — plus a structured lead-capture flow.",
      },
      {
        href: "/editor",
        icon: "mouse-pointer-click",
        title: "Click-to-Edit",
        description: "Click any element on a page to edit its text, image, or spacing in place.",
        badge: "Planned",
      },
    ],
  },
  {
    type: "text-block",
    icon: "shield-check",
    heading: "Agent security boundary",
    body: "The openclaw agent skill this project relies on has an explicit tool allowlist, a file-system access scope, and a human-confirmation gate on sensitive operations — documented and logged for audit, not assumed.",
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
      "openclaw",
    ],
  },
];

/** Fallback content for the "about" slug — same schema, same
 * never-blank-page reasoning as DEFAULT_HOME_SECTIONS above. Content
 * carried over verbatim from the page's original hand-written JSX
 * (pre-2026-08-04) when it moved onto the section-schema/save-publish
 * pipeline. */
export const DEFAULT_ABOUT_SECTIONS: PageSection[] = [
  {
    type: "hero",
    eyebrow: "Portfolio project background",
    headline: "About this project",
    subheadline: "Background, positioning, and the reasoning behind the technology choices.",
  },
  {
    type: "text-block",
    heading: "Background",
    body: "Graduated in 2014; front-end since 2016; full-stack since 2021 (PHP, SQL, HTML, CSS, JavaScript, jQuery, REST APIs, webhooks). React experience from personal projects, plus Laravel, CodeIgniter, Vite, Firebase, MongoDB, and AWS. This project is a deliberate transition into AI application development, built on a self-hosted (on-prem) stack — RAG, agents, and a vision LLM — with particular attention to agent permission boundaries and isolation, mirroring real enterprise concerns around data sovereignty and agent risk.",
  },
  {
    type: "feature-grid",
    heading: "Target roles",
    columns: 3,
    items: [
      {
        href: "#",
        title: "Full-Stack Developer",
        description: "AI project featured as the differentiator",
      },
      {
        href: "#",
        title: "AI / LLM Application Engineer",
        description: "Mid-level, not junior",
      },
      {
        href: "#",
        title: "Agent Security / On-Prem AI Deployment",
        description: "Niche differentiator",
      },
    ],
  },
  {
    type: "text-block",
    heading: "Why Next.js over Astro",
    body: "The original plan called for Astro, but most of this project is interactive by nature — user management, the click-to-edit editor, the chatbot, and RAG queries all need client-side state. Astro's static-first model doesn't play to its strengths here, and existing React experience makes Next.js the lower-cost path: routing, navigation, and TypeScript come built in via the App Router, without hand-assembling the library stack a bare React setup would need.",
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
        title: "Firebase Auth",
        description: "Email/OAuth login, JWT, and custom claims for roles — reuses existing Firebase experience.",
      },
      {
        href: "#",
        title: "Local-first inference",
        description: "Ollama and ComfyUI run on-prem; a cloud fallback interface is reserved for later.",
      },
    ],
  },
];
