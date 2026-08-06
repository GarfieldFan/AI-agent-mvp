"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A hex-color field for CTE's block-style editors — plain hex string,
 * same controlled-color pattern as `accent_color`/`ContainerBlock.
 * background_color` etc. Not free-form CSS: this is a human picking one
 * value through a native color picker (or typing/pasting a hex string),
 * the exact same value shape the schema already stores when a vision LLM
 * sets it. Undefined means "not set — inherits the theme default," not
 * black; the native color input needs *some* value to display, so it
 * falls back to a neutral "#000000" purely for the swatch, without that
 * ever being written back unless the admin actually changes it. */
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${label} color picker`}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
        />
        <Input
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value.trim() || undefined)}
          placeholder="Not set — inherits the theme default"
          className="flex-1"
        />
        {value ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
