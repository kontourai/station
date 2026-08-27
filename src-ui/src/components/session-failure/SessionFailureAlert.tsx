import type { ReactNode } from 'react';
import { describeInternalStreamFailure } from '../../utils/chatErrorTranslation';
import './SessionFailureAlert.css';

/**
 * The one way Station says "this session failed".
 *
 * station#3213: this markup lived inside `SessionDetailErrors`, so the session
 * detail was the only surface that could render it — the chat dock showed
 * nothing at all on a cold arrival at a failed session. It is lifted here
 * rather than re-spelled in the dock: a second banner with the same words is
 * how two surfaces come to describe one failure differently, which is the
 * defect class #3139/#3136/#3203 all belong to. Its text comes from the one
 * shared fold, `utils/sessionFailure`'s `sessionFailureText`.
 *
 * Renders nothing when there is no failure, so callers pass the fold's result
 * straight through without repeating a null check.
 */
export function SessionFailureAlert({
  failureText,
  note,
  className,
  testId = 'session-failure',
}: {
  /** `sessionFailureText(session, events)` — `null` when nothing failed. */
  failureText: string | null;
  /**
   * One surface-specific sentence under the cause, for a surface that can say
   * something true about what happens NEXT. The dock says the session can be
   * continued because its composer is right below and still works; the session
   * detail says nothing, because it hides its composer for a terminal session
   * and a "you can continue" line there would name an affordance that is not
   * on screen.
   */
  note?: ReactNode;
  /**
   * Host-owned PLACEMENT only — the surrounding inset this banner needs in
   * its own pane. Everything the banner looks like (border, colour, type
   * scale, the wrap/clamp policy) stays in `SessionFailureAlert.css`, so a
   * host cannot restyle the failure into its own dialect.
   */
  className?: string;
  /**
   * Distinct per surface on purpose: the dock is mounted over the session
   * detail, so one shared id would match two elements on that page.
   */
  testId?: string;
}) {
  if (!failureText) return null;
  // The banner quotes the recorded cause VERBATIM (station#3213: one fold,
  // one quote, two surfaces that cannot disagree) — with exactly one
  // rewrite: a cause whose entire content is a browser/parser internal
  // (`Failed to execute 'close' on 'ReadableStreamDefaultController'…`,
  // station#3299) names a JS API, not anything the user can act on, and is
  // replaced by the same product sentence the transcript's error card
  // prints for that shape. Causes carrying real diagnostic content (hosts,
  // paths, engine names) are never rewritten — see
  // `describeInternalStreamFailure`'s doc comment for why the full
  // translation table would misattribute them.
  const displayText = describeInternalStreamFailure(failureText) ?? failureText;
  return (
    <div
      className={className ? `session-failure ${className}` : 'session-failure'}
      role="alert"
      data-testid={testId}
    >
      <p className="session-failure__cause">
        <strong>Failed:</strong> {displayText}
      </p>
      {note ? <p className="session-failure__note">{note}</p> : null}
    </div>
  );
}
