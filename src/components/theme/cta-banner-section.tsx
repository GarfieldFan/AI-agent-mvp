import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Button } from "@/components/ui/button";
import { AddItemButton } from "@/components/theme/cte/add-item-button";
import { Editable } from "@/components/theme/cte/editable";
import type { CtaBannerSection as CtaBannerSectionData, ThemeCta } from "@/lib/theme";

const NEW_CTA: ThemeCta = { label: "New button", href: "#", variant: "outline" };

type CtaBannerSectionProps = CtaBannerSectionData & { sectionIndex: number };

export function CtaBannerSection({ sectionIndex, heading, body, ctas }: CtaBannerSectionProps) {
  return (
    <section className="border-t">
      <Container className="flex flex-col items-center gap-4 py-16 text-center">
        <h2 className="text-2xl font-semibold">
          <Editable path={`${sectionIndex}.heading`} fieldType="text" value={heading}>
            {heading}
          </Editable>
        </h2>
        {body ? (
          <p className="max-w-xl text-muted-foreground">
            <Editable path={`${sectionIndex}.body`} fieldType="text" value={body}>
              {body}
            </Editable>
          </p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-3">
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
      </Container>
    </section>
  );
}
