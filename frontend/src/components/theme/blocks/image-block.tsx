import { cn } from "@/lib/utils";
import { Editable } from "@/components/theme/cte/editable";
import { ThemeImageBox } from "@/components/theme/theme-image-box";
import type { ImageBlock as ImageBlockData } from "@/lib/theme";

// "auto" is NOT actually unconstrained — see this component's 2026-08-05
// bugfix note below. Falls back to the same ratio as "video".
const ASPECT_CLASS: Record<NonNullable<ImageBlockData["aspect_ratio"]>, string> = {
  square: "aspect-square",
  video: "aspect-video",
  portrait: "aspect-[3/4]",
  auto: "aspect-video",
};

const ROUNDED_CLASS: Record<NonNullable<ImageBlockData["rounded"]>, string> = {
  none: "",
  sm: "rounded-md",
  lg: "rounded-2xl",
  full: "rounded-full",
};

/** **2026-08-05 bugfix, found from a real vision-LLM generation**: `"auto"`
 * used to mean a genuinely unconstrained box (no `aspect-*` class, no
 * explicit height). That's fragile across the contexts a block can land
 * in — specifically, an ImageBlock as a direct child of a `layout: "row"`
 * ContainerBlock (wrapped in `flex-1 min-w-0` by BlockRenderer) collapsed
 * to ~0px tall: the wrapper div had no defined height, so
 * ThemeImageBox's own `h-full` placeholder had nothing real to resolve
 * against, even though the *row* itself was correctly stretched to match
 * its tallest sibling. Every other image-rendering component in this
 * codebase (Hero, TextBlock, FeatureCardWithImage) always applies a fixed
 * aspect ratio for exactly this reason — "auto" was the one place that
 * didn't, and it broke the first time a real generation actually used it. */
export function ImageBlock({
  image,
  aspect_ratio = "auto",
  rounded = "lg",
  width,
  path,
}: ImageBlockData & { path: string }) {
  return (
    <Editable
      as="div"
      path={path}
      fieldType="block-image"
      value={{ type: "image", image, aspect_ratio, rounded, width }}
      className={cn("w-full overflow-hidden", ASPECT_CLASS[aspect_ratio], ROUNDED_CLASS[rounded])}
    >
      <ThemeImageBox image={image} />
    </Editable>
  );
}
