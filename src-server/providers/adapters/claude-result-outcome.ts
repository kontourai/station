/**
 * An SDK error result proves this query/turn failed. It does not by itself
 * prove the provider's persisted native session is missing or resumable.
 * Claude currently has no structured missing-session discriminator, so the
 * legacy binding-dead case requires its exact diagnostic for the native
 * cursor this query actually attempted. Other failures remain unclassified.
 */
export type ClaudeResultOutcome = 'ok' | 'failed' | 'binding-dead';

export interface ClaudeResultLike {
  type: 'result';
  is_error: boolean;
  result?: unknown;
  errors?: unknown;
}

export function classifyClaudeResultOutcome(
  message: ClaudeResultLike,
  attemptedResumeCursor?: string,
): ClaudeResultOutcome {
  if (message.is_error === false) return 'ok';
  if (
    message.is_error === true &&
    typeof attemptedResumeCursor === 'string' &&
    attemptedResumeCursor.length > 0 &&
    attemptedResumeCursor.length <= 256 &&
    [...attemptedResumeCursor].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
    claudeResultFailureText(message).trim() ===
      `No conversation found with session ID: ${attemptedResumeCursor}`
  )
    return 'binding-dead';
  return 'failed';
}

/**
 * Reduces an SDK `result` message to display/report text for a failed
 * outcome. `SDKResultSuccess` (subtype `'success'`, which `is_error: true`
 * can still occur on) carries the failure text
 * in `result`; `SDKResultError` (subtype `'error_*'`) carries no `result`
 * field at all, only `errors: string[]`. Never throws: an SDK message that
 * matches neither documented shape still gets a bounded, honest fallback
 * rather than surfacing `undefined` to the user.
 */
export function claudeResultFailureText(message: {
  result?: unknown;
  errors?: unknown;
}): string {
  if (typeof message.result === 'string' && message.result.trim()) {
    return message.result;
  }
  if (Array.isArray(message.errors)) {
    const joined = message.errors
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join('; ');
    if (joined) return joined;
  }
  return 'The engine ended this turn with an error.';
}
