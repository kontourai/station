/**
 * Pure classifier for a Claude Agent SDK `result` message's outcome —
 * archive#1827, mirroring `classifyConnectionFailure`'s pattern
 * (`connection-recovery-policy.ts`): a small, directly-unit-testable
 * function that reduces an untrusted SDK message to a bounded
 * classification instead of leaving callers to parse the engine's prose.
 *
 * The SDK's own generic-failure wrapper ("Claude Code returned an error
 * result: <prose>", thrown when the underlying `claude` CLI process exits
 * abnormally) carries no error code — see the doc comment on
 * `ENGINE_SESSION_BINDING_DEAD_CODE` (`packages/contracts/src/provider.ts`)
 * for the incident this classifier exists to fix (a dead `--resume` binding
 * replayed and retried forever because nothing but that prose distinguished
 * it from a transient failure). But the STRUCTURED `result` message that
 * precedes the thrown wrapper already flags the outcome via `is_error` — a
 * boolean the SDK sets from its own message protocol, not from parsing
 * text (confirmed against `@anthropic-ai/claude-agent-sdk`'s `sdk.mjs`:
 * `Query`'s `lastErrorResultText` is set directly off `is_error` on every
 * `result` message, and is what the eventual wrapped Error's text is built
 * from).
 *
 * `is_error === true` on a `result` message always ends that query/turn in
 * failure and is classified `terminal` here: whatever the underlying cause
 * (a dead `--resume` binding, a rejected turn, a CLI-side crash, ...), the
 * SDK itself is reporting the exchange cannot silently continue. Callers
 * that observe `terminal` must stop treating the engine binding this
 * message arrived on as resumable and surface the failure structurally
 * (a `runtime.error`, not a normal completed turn) instead of folding the
 * engine's error text into what looks like an ordinary assistant reply.
 */
export type ClaudeResultOutcome = 'ok' | 'terminal';

/** The narrow shape this classifier needs off an SDK `result` message. */
export interface ClaudeResultLike {
  type: 'result';
  is_error: boolean;
}

export function classifyClaudeResultOutcome(
  message: ClaudeResultLike,
): ClaudeResultOutcome {
  return message.is_error ? 'terminal' : 'ok';
}

/**
 * Reduces an SDK `result` message to display/report text for a terminal
 * outcome. `SDKResultSuccess` (subtype `'success'`, which `is_error: true`
 * can still occur on — see the module doc comment) carries the failure text
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
