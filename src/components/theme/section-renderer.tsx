import type { CSSProperties } from "react";

import type { PageSection } from "@/lib/theme";
import { Container } from "@/components/layout/container";
import { HeroSection } from "@/components/theme/hero-section";
import { FeatureGridSection } from "@/components/theme/feature-grid-section";
import { CarouselSection } from "@/components/theme/carousel-section";
import { TextBlockSection } from "@/components/theme/text-block-section";
import { CtaBannerSection } from "@/components/theme/cta-banner-section";
import { BadgeListSection } from "@/components/theme/badge-list-section";
import { ContainerBlock } from "@/components/theme/blocks/container-block";

type SectionRendererProps = {
  sections: PageSection[];
  /** Hex color the vision LLM picked out of the design image (see
   * lib/theme.ts's `GeneratedPage.accentColor`). Applied as a `--primary`
   * CSS custom-property override scoped to this render, retinting
   * existing components (buttons, badges, icons) rather than allowing any
   * generated CSS — deliberately a rough approximation, not full-fidelity
   * theming (e.g. `--primary-foreground` contrast isn't recomputed). */
  accentColor?: string;
  /** Added 2026-08-06. Offsets every section's own CTE path (and React
   * key) by this amount — lets a caller render a *slice* of `sections`
   * (e.g. CteEditorPanel rendering one section at a time, to wrap each
   * in its own move/delete controls) while every `Editable` inside it
   * still addresses its real position in the *full* array, not 0. Without
   * this, slicing to `sections={[section]}` would make every field
   * inside it write to path "0.xxx" regardless of where that section
   * actually lives, corrupting whichever section really sits at index 0.
   * Defaults to 0, so every existing full-array call site is unaffected. */
  startIndex?: number;
  /** Added 2026-08-06 (CTE part 10). When true, a top-level `container`
   * section's own `block-container` edit badge is suppressed — used only
   * by `CteEditorPanel`, which folds that same "edit this container"
   * action into its per-section move/delete toolbar instead (matching
   * the merge already done for nested container children — see
   * `ArrayItemToolbar`'s doc comment). Every other caller (public routes,
   * `PageGeneratorPanel`'s preview) leaves this unset, so a top-level
   * container section still shows its own corner badge there, same as
   * before this existed. */
  mergeContainerBadge?: boolean;
};

/** Renders an ordered list of page sections — the shared path for both
 * the hand-authored default template (see src/config/default-theme.ts)
 * and vision-LLM-generated pages returned by backend/apis/agent.py's
 * generate_landing_page. Every section type in lib/theme.ts must have a
 * case here; an unrecognized `type` is skipped rather than crashing the
 * page (defensive against a future schema version mismatch or a
 * malformed generated page). */
export function SectionRenderer({ sections, accentColor, startIndex = 0, mergeContainerBadge }: SectionRendererProps) {
  const rendered = sections.map((section, offset) => {
    const index = startIndex + offset;
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
      case "container":
        // full_bleed skips the page's standard max-width wrapper for this
        // one section (see lib/theme.ts's doc comment) — everything else
        // still gets it, same as every other section type.
        return section.full_bleed ? (
          <section key={index}>
            <ContainerBlock {...section} path={String(index)} hideOwnBadge={mergeContainerBadge} />
          </section>
        ) : (
          <section key={index}>
            <Container className="py-16">
              <ContainerBlock {...section} path={String(index)} hideOwnBadge={mergeContainerBadge} />
            </Container>
          </section>
        );
      default:
        return null;
    }
  });

  if (!accentColor) return <>{rendered}</>;

  return <div style={{ "--primary": accentColor } as CSSProperties}>{rendered}</div>;
}
