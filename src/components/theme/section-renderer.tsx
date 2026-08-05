import type { CSSProperties } from "react";

import type { PageSection } from "@/lib/theme";
import { HeroSection } from "@/components/theme/hero-section";
import { FeatureGridSection } from "@/components/theme/feature-grid-section";
import { CarouselSection } from "@/components/theme/carousel-section";
import { TextBlockSection } from "@/components/theme/text-block-section";
import { CtaBannerSection } from "@/components/theme/cta-banner-section";
import { BadgeListSection } from "@/components/theme/badge-list-section";

type SectionRendererProps = {
  sections: PageSection[];
  /** Hex color the vision LLM picked out of the design image (see
   * lib/theme.ts's `GeneratedPage.accentColor`). Applied as a `--primary`
   * CSS custom-property override scoped to this render, retinting
   * existing components (buttons, badges, icons) rather than allowing any
   * generated CSS — deliberately a rough approximation, not full-fidelity
   * theming (e.g. `--primary-foreground` contrast isn't recomputed). */
  accentColor?: string;
};

/** Renders an ordered list of page sections — the shared path for both
 * the hand-authored default template (see src/config/default-theme.ts)
 * and vision-LLM-generated pages returned by backend/apis/agent.py's
 * generate_landing_page. Every section type in lib/theme.ts must have a
 * case here; an unrecognized `type` is skipped rather than crashing the
 * page (defensive against a future schema version mismatch or a
 * malformed generated page). */
export function SectionRenderer({ sections, accentColor }: SectionRendererProps) {
  const rendered = sections.map((section, index) => {
    switch (section.type) {
      case "hero":
        return <HeroSection key={index} sectionIndex={index} {...section} />;
      case "feature-grid":
        return <FeatureGridSection key={index} sectionIndex={index} {...section} />;
      case "carousel":
        return <CarouselSection key={index} {...section} />;
      case "text-block":
        return <TextBlockSection key={index} sectionIndex={index} {...section} />;
      case "cta-banner":
        return <CtaBannerSection key={index} sectionIndex={index} {...section} />;
      case "badge-list":
        return <BadgeListSection key={index} sectionIndex={index} {...section} />;
      default:
        return null;
    }
  });

  if (!accentColor) return <>{rendered}</>;

  return <div style={{ "--primary": accentColor } as CSSProperties}>{rendered}</div>;
}
