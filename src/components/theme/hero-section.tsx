import Link from "next/link";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { Container } from "@/components/layout/container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddItemButton } from "@/components/theme/cte/add-item-button";
import { ArrayItemToolbar } from "@/components/theme/cte/array-item-toolbar";
import { Editable } from "@/components/theme/cte/editable";
import { resolveRichText, richTextStyle } from "@/components/theme/rich-text";
import { themeButtonClassName, themeCtaStyle } from "@/components/theme/theme-cta-style";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import type { HeroSection as HeroSectionData, ThemeCta } from "@/lib/theme";

const NEW_CTA: ThemeCta = { label: "New button", href: "#", variant: "outline" };

type HeroSectionProps = HeroSectionData & { sectionIndex: number };

export function HeroSection({
  sectionIndex,
  eyebrow,
  headline,
  subheadline,
  ctas,
  image,
  background_color,
  image_position = "right",
}: HeroSectionProps) {
  const headlineRt = resolveRichText(headline);
  const subheadlineRt = subheadline ? resolveRichText(subheadline) : null;

  const textColumn = (
    <div className="flex flex-col items-start gap-6">
      {eyebrow ? (
        <Badge variant="outline">
          <Editable path={`${sectionIndex}.eyebrow`} fieldType="text" value={eyebrow}>
            {eyebrow}
          </Editable>
        </Badge>
      ) : null}
      <h1
        className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl"
        style={richTextStyle(headlineRt)}
      >
        <Editable path={`${sectionIndex}.headline`} fieldType="rich-text" value={headlineRt}>
          {headlineRt.content}
        </Editable>
      </h1>
      {subheadlineRt ? (
        <p className="max-w-xl text-lg text-muted-foreground" style={richTextStyle(subheadlineRt)}>
          <Editable path={`${sectionIndex}.subheadline`} fieldType="rich-text" value={subheadlineRt}>
            {subheadlineRt.content}
          </Editable>
        </p>
      ) : null}
      {ctas && ctas.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          {ctas.map((cta, ctaIndex) => (
            <div key={cta.href} className="group relative">
              <ArrayItemToolbar
                path={`${sectionIndex}.ctas.${ctaIndex}`}
                disableBack={ctaIndex === 0}
                disableForward={ctaIndex === ctas.length - 1}
              />
              <Editable
                as="div"
                path={`${sectionIndex}.ctas.${ctaIndex}`}
                fieldType="cta"
                value={cta}
              >
                <Button
                  size={cta.size ?? "lg"}
                  variant={cta.variant ?? "default"}
                  nativeButton={false}
                  render={<Link href={cta.href} />}
                  className={themeButtonClassName(cta)}
                  style={themeCtaStyle(cta)}
                >
                  {cta.label}
                </Button>
              </Editable>
            </div>
          ))}
          <AddItemButton
            path={`${sectionIndex}.ctas`}
            fieldType="cta"
            defaultValue={NEW_CTA}
            label="Add button"
            className="h-9 rounded-lg px-3"
          />
        </div>
      ) : (
        <AddItemButton
          path={`${sectionIndex}.ctas`}
          fieldType="cta"
          defaultValue={NEW_CTA}
          label="Add button"
          className="h-9 rounded-lg px-3"
        />
      )}
    </div>
  );

  // A colored, image-less hero reads as a compact banner strip in every
  // source design tested so far, not a big spacious hero — the same fixed
  // py-20/py-28 used for a normal hero left way too much empty space
  // above/below a couple of lines of text on a colored background.
  const isBanner = Boolean(background_color) && !image;

  return (
    <section
      className={cn("border-b", !background_color && "bg-muted/30")}
      style={background_color ? ({ backgroundColor: background_color } as CSSProperties) : undefined}
    >
      <Container
        className={cn(
          isBanner ? "py-10 sm:py-14" : "py-20 sm:py-28",
          image ? "grid items-center gap-10 lg:grid-cols-2" : "flex flex-col items-start",
        )}
      >
        {image && image_position === "left" ? (
          <Editable
            as="div"
            path={`${sectionIndex}.image`}
            fieldType="image"
            value={image}
            className="aspect-[4/3] w-full overflow-hidden rounded-2xl"
          >
            <ThemeImageBox image={image} />
          </Editable>
        ) : null}
        {textColumn}
        {image && image_position !== "left" ? (
          <Editable
            as="div"
            path={`${sectionIndex}.image`}
            fieldType="image"
            value={image}
            className="aspect-[4/3] w-full overflow-hidden rounded-2xl"
          >
            <ThemeImageBox image={image} />
          </Editable>
        ) : null}
      </Container>
    </section>
  );
}
