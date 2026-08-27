/**
 * What a refused request actually said.
 *
 * Lives in `client/` deliberately (station#3749): the React-free client entry
 * may only import its own siblings, and every fetcher under `client/` routes
 * its refusals through this function. `api-core` re-exports it, so the rest of
 * the SDK has one import site and the whole package has one rule.
 *
 * The shared zod middleware answers a rejected body with
 * `{ error: 'Validation failed', details: { fieldErrors } }` — the sentence
 * naming the broken rule is in `details`, and a caller reading `result.error`
 * alone can only ever show "Validation failed". A skill save refused for an
 * untypable command word therefore reached the editor with nothing to say
 * (station#3737).
 *
 * Reads the details when they are there and falls back to the envelope's own
 * message when they are not. Every refusal in this package goes through here —
 * the 152 hand-rolled `result.error || 'Something failed'` lines were swept in
 * station#3749 and `scripts/sdk-error-message-ratchet.mjs` keeps the count at
 * zero, because an unadopted helper regrows silently.
 */
export function apiErrorMessage(
  result: {
    error?: unknown;
    message?: unknown;
    details?: { formErrors?: unknown; fieldErrors?: unknown };
  },
  fallback: string,
): string {
  const parts: string[] = [];
  const formErrors = result.details?.formErrors;
  if (Array.isArray(formErrors)) {
    for (const entry of formErrors) {
      if (typeof entry === 'string' && entry.trim()) parts.push(entry);
    }
  }
  const fieldErrors = result.details?.fieldErrors;
  if (fieldErrors && typeof fieldErrors === 'object') {
    for (const messages of Object.values(
      fieldErrors as Record<string, unknown>,
    )) {
      if (!Array.isArray(messages)) continue;
      for (const entry of messages) {
        if (typeof entry === 'string' && entry.trim()) parts.push(entry);
      }
    }
  }
  if (parts.length > 0) return parts.join(' ');
  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error;
  }
  if (typeof result.message === 'string' && result.message.trim()) {
    return result.message;
  }
  return fallback;
}
