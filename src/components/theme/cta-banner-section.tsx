import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Button } from "@/components/ui/button";
import { AddItemButton } from "@/components/theme/cte/add-item-button";
import { ArrayItemToolbar } from "@/components/theme/cte/array-item-toolbar";
import { Editable } from "@/components/theme/cte/editable";
import { resolveRichText, richTextStyle } from "@/components/theme/rich-text";
import { themeButtonClassName, themeCtaStyle } from "@/components/theme/theme-cta-style";
import type { CtaBannerSection as CtaBannerSectionData, ThemeCta } from "@/lib/theme";

const NEW_CTA: ThemeCta = { label: "New button", href: "#", variant: "outline" };

type CtaBannerSectionProps = CtaBannerSectionData & { sectionIndex: number };

export function CtaBannerSection({ sectionIndex, heading, body, ctas }: CtaBannerSectionProps) {
  const headingRt = resolveRichText(heading);
  const bodyRt = body ? resolveRichText(body) : null;

  return (
    <section className="border-t">
      <Container className="flex flex-col items-center gap-4 py-16 text-center">
        <h2 className="text-2xl font-semibold" style={richTextStyle(headingRt)}>
          <Editable path={`${sectionIndex}.heading`} fieldType="rich-text" value={headingRt}>
            {headingRt.content}
          </Editable>
        </h2>
        {bodyRt ? (
          <p className="max-w-xl text-muted-foreground" style={richTextStyle(bodyRt)}>
            <Editable path={`${sectionIndex}.body`} fieldType="rich-text" value={bodyRt}>
              {bodyRt.content}
            </Editable>
          </p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-3">
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
      </Container>
    </section>
  );
}
