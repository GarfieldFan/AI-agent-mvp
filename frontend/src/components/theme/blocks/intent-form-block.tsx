"use client";

import { StructuredIntakeForm } from "@/components/modules/structured-intake-form";
import { Editable } from "@/components/theme/cte/editable";
import type { IntentFormBlock as IntentFormBlockData } from "@/lib/theme";

/** A whole-form StructuredIntakeForm wizard, owner-bound to one
 * IntentSchema (2026-09-22) — see lib/theme.ts's IntentFormBlock doc
 * comment. StructuredIntakeForm already handles its own loading/error/
 * no-template states, so this wrapper only needs to handle the
 * `schema_key: null` (freshly-inserted, nothing picked yet) case,
 * mirroring ProductCardBlock's own `product_id: null` placeholder. */
export function IntentFormBlock({ schema_key, path }: IntentFormBlockData & { path: string }) {
  return (
    <Editable
      as="div"
      path={path}
      fieldType="block-intent-form"
      value={{ type: "intent-form", schema_key }}
    >
      {schema_key == null ? (
        <p className="text-sm text-muted-foreground">No form picked yet — edit this block to choose one.</p>
      ) : (
        <StructuredIntakeForm schemaKey={schema_key} />
      )}
    </Editable>
  );
}
