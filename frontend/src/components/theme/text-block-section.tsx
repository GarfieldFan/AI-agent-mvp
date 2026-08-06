import { cn } from "@/lib/utils";
import { Container } from "@/components/layout/container";
import { Editable } from "@/components/theme/cte/editable";
import { ThemeIcon } from "@/components/theme/icon-registry";
import { resolveRichText, richTextStyle } from "@/components/theme/rich-text";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import type { TextBlockSection as TextBlockSectionData } from "@/lib/theme";

type TextBlockSectionProps = TextBlockSectionData & { sectionIndex: number };

export function TextBlockSection({
  sectionIndex,
  icon,
  heading,
  body,
  align = "left",
  image,
  image_position = "right",
  background_image,
}: TextBlockSectionProps) {
  const headingRt = resolveRichText(heading);
  const bodyRt = resolveRichText(body);

  // Mutually exclusive with `image` — a section either sits over a photo
  // or beside one, not both. See lib/theme.ts's field comments.
  if (background_image) {
    return (
      <section className="relative overflow-hidden">
        <Editable
          as="div"
          path={`${sectionIndex}.background_image`}
          fieldType="image"
          value={background_image}
          className="absolute inset-0"
        >
          <ThemeImageBox image={background_image} />
        </Editable>
        <div className="absolute inset-0 bg-black/55" />
        <Container className="relative py-24 text-center">
          <div className="mx-auto max-w-2xl space-y-2 text-white">
            <h2 className="text-2xl font-semibold" style={richTextStyle(headingRt)}>
              <Editable path={`${sectionIndex}.heading`} fieldType="rich-text" value={headingRt}>
                {headingRt.content}
              </Editable>
            </h2>
            <p className="text-sm text-white/85" style={richTextStyle(bodyRt)}>
              <Editable path={`${sectionIndex}.body`} fieldType="rich-text" value={bodyRt}>
                {bodyRt.content}
              </Editable>
            </p>
          </div>
        </Container>
      </section>
    );
  }

  const textColumn = (
    <div
      className={cn(
        "flex items-start gap-3",
        align === "center" && !image && "flex-col items-center text-center",
      )}
    >
      {icon ? <ThemeIcon name={icon} className="mt-1 size-6 shrink-0 text-primary" /> : null}
      <div className="space-y-1">
        <h2 className="text-xl font-semibold" style={richTextStyle(headingRt)}>
          <Editable path={`${sectionIndex}.heading`} fieldType="rich-text" value={headingRt}>
            {headingRt.content}
          </Editable>
        </h2>
        <p className="max-w-xl text-sm text-muted-foreground" style={richTextStyle(bodyRt)}>
          <Editable path={`${sectionIndex}.body`} fieldType="rich-text" value={bodyRt}>
            {bodyRt.content}
          </Editable>
        </p>
      </div>
    </div>
  );

  if (image) {
    const imageFirst = image_position === "left";
    const imageBox = (
      <Editable
        as="div"
        path={`${sectionIndex}.image`}
        fieldType="image"
        value={image}
        className="aspect-[4/3] w-full overflow-hidden rounded-2xl"
      >
        <ThemeImageBox image={image} />
      </Editable>
    );
    return (
      <section className="border-t bg-muted/30">
        <Container className="grid items-center gap-10 py-16 lg:grid-cols-2">
          {imageFirst ? imageBox : null}
          {textColumn}
          {!imageFirst ? imageBox : null}
        </Container>
      </section>
    );
  }

  return (
    <section className="border-t bg-muted/30">
      <Container className={cn("py-16", align === "center" && "text-center")}>
        {textColumn}
      </Container>
    </section>
  );
}
