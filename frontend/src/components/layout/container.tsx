import { cn } from "@/lib/utils";

type ContainerProps = React.ComponentProps<"div">;

/** Centers content and caps its width — the base horizontal rhythm every
 * page/section should use instead of repeating max-w/mx-auto/px by hand. */
export function Container({ className, ...props }: ContainerProps) {
  return (
    <div
      className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8", className)}
      {...props}
    />
  );
}
