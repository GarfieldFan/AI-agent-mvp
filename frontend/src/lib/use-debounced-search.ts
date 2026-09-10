import * as React from "react";

/** Debounces `input` into a stable value after `delayMs` (default 300).
 * When `setPage` is given, it's reset to 1 inside the SAME timeout
 * callback that updates the debounced value — not a separate effect
 * watching the debounced value, which would trip
 * `react-hooks/set-state-in-effect` for an effect that exists purely to
 * reset one piece of derived state (see the root AGENTS.md's "Known
 * gotchas"). `setPage` is optional: a caller that resets the page on
 * more than just this search box (e.g. also on a status filter change)
 * should omit it here and keep its own combined reset effect instead.
 *
 * Extracted 2026-09-11 from an identical 6-line effect that had been
 * hand-copied into ChatSessionViewerPanel/CteEditorPanel/PageManager
 * (each already cross-referencing the others in its own comments) and a
 * near-identical, split-into-two-effects variant in OrderPanel. */
export function useDebouncedSearch(input: string, setPage?: (page: number) => void, delayMs = 300): string {
  const [debounced, setDebounced] = React.useState(input);

  React.useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(input);
      setPage?.(1);
    }, delayMs);
    return () => window.clearTimeout(id);
  }, [input, setPage, delayMs]);

  return debounced;
}
