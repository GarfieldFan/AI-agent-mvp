import Link from "next/link";

import { cn } from "@/lib/utils";
import { Container } from "@/components/layout/container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddItemButton } from "@/components/theme/cte/add-item-button";
import { Editable } from "@/components/theme/cte/editable";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import type { HeroSection as HeroSectionData, ThemeCta } from "@/lib/theme";

const NEW_CTA: ThemeCta = { label: "New button", href: "#", variant: "outline" };

type HeroSectionProps = HeroSectionData & { sectionIndex: number };

export function HeroSection({ sectionIndex, eyebrow, headline, subheadline, ctas, image }: HeroSectionProps) {
  const textColumn = (
    <div className="flex flex-col items-start gap-6">
      {eyebrow ? (
        <Badge variant="outline">
          <Editable path={`${sectionIndex}.eyebrow`} fieldType="text" value={eyebrow}>
            {eyebrow}
          </Editable>
        </Badge>
      ) : null}
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
        <Editable path={`${sectionIndex}.headline`} fieldType="text" value={headline}>
          {headline}
        </Editable>
      </h1>
      {subheadline ? (
        <p className="max-w-xl text-lg text-muted-foreground">
          <Editable path={`${sectionIndex}.subheadline`} fieldType="text" value={subheadline}>
            {subheadline}
          </Editable>
        </p>
      ) : null}
      {ctas && ctas.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          {ctas.map((cta, ctaIndex) => (
            <Editable
              key={cta.href}
              as="div"
              path={`${sectionIndex}.ctas.${ctaIndex}`}
              fieldType="cta"
              value={cta}
            >
              <Button
                size="lg"
                variant={cta.variant ?? "default"}
                nativeButton={false}
                render={<Link href={cta.href} />}
              >
                {cta.label}
              </Button>
            </Editable>
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

  return (
    <section className="border-b bg-muted/30">
      <Container
        className={cn(
          "py-20 sm:py-28",
          image ? "grid items-center gap-10 lg:grid-cols-2" : "flex flex-col items-start",
        )}
      >
        {textColumn}
        {image ? (
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
