/**
 * Shared "extract a displayable message from an unknown error" helper (K4
 * code-review DRY finding — this ternary was previously duplicated across
 * `KnowledgeStoreSection.tsx` and `project-settings/KnowledgeSection.tsx`
 * with two slightly different, unintentionally-inconsistent fallback
 * strings). Every `ErrorState`/inline error-message call site in this repo
 * should converge on this one implementation and fallback copy rather than
 * re-deriving its own `error instanceof Error ? ... : ...` ternary.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
