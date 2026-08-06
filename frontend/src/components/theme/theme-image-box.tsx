import { cn } from "@/lib/utils";
import type { ThemeImage } from "@/lib/theme";

const PLACEHOLDER_GRADIENTS = [
  "from-amber-200 to-orange-300",
  "from-emerald-200 to-teal-300",
  "from-sky-200 to-blue-300",
  "from-rose-200 to-pink-300",
  "from-violet-200 to-purple-300",
];

/** Deterministic (not random) so server- and client-render pick the same
 * gradient for the same alt text — Math.random() here would cause a
 * hydration mismatch. */
function pickGradient(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PLACEHOLDER_GRADIENTS[hash % PLACEHOLDER_GRADIENTS.length];
}

type ThemeImageBoxProps = {
  image?: ThemeImage;
  className?: string;
};

/** Renders a `ThemeImage`, or a soft gradient placeholder captioned with
 * its alt text when there's no real URL yet. The vision LLM can describe
 * an image it sees in a design ("hands holding fruit") but can't invent a
 * working URL for it — backend/apis/agent.py's prompt tells it to use
 * `"#"` in that case — so this is the one place that turns "no image"
 * into something presentable instead of a gap or a broken `<img>`. Used
 * by HeroSection, FeatureGridSection's items, and CarouselSection. */
export function ThemeImageBox({ image, className }: ThemeImageBoxProps) {
  const hasRealImage = Boolean(image?.url) && image!.url !== "#";

  if (hasRealImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- see carousel-section.tsx: host isn't known ahead of time
      <img src={image!.url} alt={image!.alt} className={cn("h-full w-full object-cover", className)} />
    );
  }

  const caption = image?.alt;
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center bg-gradient-to-br p-4 text-center text-xs text-foreground/60",
        pickGradient(caption ?? "placeholder"),
        className,
      )}
    >
      {caption ? <span className="line-clamp-3">{caption}</span> : null}
    </div>
  );
}
