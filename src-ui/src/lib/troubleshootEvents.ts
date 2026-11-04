/**
 * Troubleshoot-with-an-agent open event (#4470).
 *
 * Same shape as `reportProblemEvents`: entry points (help menu, ⌘K palette,
 * Settings, and the error surfaces' Troubleshoot actions) dispatch this window
 * event, and `TroubleshootHost`, mounted from `DeferredAppOverlays`, listens
 * and runs the start flow. The help menu inlines the literal for the same
 * entry-chunk reason it inlines the report-problem event.
 *
 * An error entry point passes the raw facts it has. The host turns them into
 * the sanitized, bounded seed (`troubleshootSeed.ts`), so the one sanitizer
 * stays out of the entry chunk and no entry point can skip it.
 */

export const OPEN_TROUBLESHOOT_EVENT = 'station:open-troubleshoot';

/** What an error surface knows about the failure it shows. */
export interface TroubleshootRequest {
  /** A short machine code: an HTTP status, a runtime error code, a pane state. */
  code?: string | number;
  /** The error message the person saw. Only its first line is used. */
  message?: string;
  /** The conversation a failed turn or rated reply belongs to. */
  conversationId?: string;
  /** The failed or rated turn, when known. */
  turnId?: string;
}

export function requestTroubleshoot(request?: TroubleshootRequest): void {
  window.dispatchEvent(
    new CustomEvent<TroubleshootRequest | undefined>(OPEN_TROUBLESHOOT_EVENT, {
      detail: request,
    }),
  );
}
