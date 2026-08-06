import { createElement } from "react";
import {
  BarChart3,
  FileText,
  HelpCircle,
  Home,
  Image as ImageIcon,
  Info,
  LayoutDashboard,
  Library,
  MessagesSquare,
  MousePointerClick,
  Quote,
  Rocket,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  library: Library,
  "messages-square": MessagesSquare,
  "mouse-pointer-click": MousePointerClick,
  "shield-check": ShieldCheck,
  sparkles: Sparkles,
  home: Home,
  info: Info,
  "layout-dashboard": LayoutDashboard,
  quote: Quote,
  rocket: Rocket,
  star: Star,
  zap: Zap,
  users: Users,
  "file-text": FileText,
  image: ImageIcon,
  "bar-chart": BarChart3,
  settings: Settings,
};

/** Resolves a schema icon key (e.g. `"shield-check"`, possibly chosen by
 * an LLM) to an actual Lucide component. Icons can't be serialized as
 * JSON — they're functions — so `lib/theme.ts`'s schema carries string
 * keys instead; this is the one place that maps back to real components.
 * An unknown/hallucinated key falls back to a generic icon instead of
 * crashing the render. */
export function resolveIcon(key?: string): LucideIcon {
  if (!key) return HelpCircle;
  return ICONS[key] ?? HelpCircle;
}

/** Renders a schema icon key. Uses `createElement` rather than assigning
 * `resolveIcon(key)` to a local variable and writing it as a JSX tag —
 * the latter trips the `react-hooks/static-components` lint rule, which
 * (reasonably, just not here) suspects a component type being constructed
 * fresh every render. `resolveIcon` only ever returns a stable reference
 * from the module-level `ICONS` map, so that's a false positive — this is
 * the one place that works around it, so nowhere else has to. */
export function ThemeIcon({ name, className }: { name?: string; className?: string }) {
  return createElement(resolveIcon(name), { className, "aria-hidden": true });
}
