import type {
  ConnectionRecoveryOutcomeReason,
  ConnectionRecoveryProjection,
} from '@kontourai/station-contracts/connection-recovery';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useEffect, useId, useRef, useState } from 'react';
import { useUsageLimitRecovery } from '../../hooks/useUsageLimitRecovery';
import { Button } from '../Button';
import './UsageLimitBanner.css';

/**
 * #3157: how long a retired stop's reason stays up. The reason is information,
 * not a task: it clears itself, and Dismiss clears it sooner.
 */
const NOTICE_MS = 10_000;
/** Past the reset, the server settles the stop on its own timer; read it after. */
const SETTLE_MS = 1_500;
const MAX_TIMER_MS = 2 ** 31 - 1 - SETTLE_MS;

const RETIRED_COPY: Record<ConnectionRecoveryOutcomeReason, string> = {
  'auto-resume-off': 'Auto-resume is off.',
  superseded: 'Auto-resume canceled: a newer message was sent.',
  'request-pending':
    'Auto-resume canceled: the conversation was waiting on a request.',
  'session-ended': 'Auto-resume canceled: the session has ended.',
  'user-canceled': 'Auto-resume canceled.',
};

/** The reset as a local time, with the weekday when it is not today. */
function formatReset(iso: string, nowMs: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return at.toDateString() === new Date(nowMs).toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

const isWaiting = (recovery: ConnectionRecoveryProjection | null) =>
  recovery?.usageLimit === true &&
  (recovery.outcome === 'armed' || recovery.outcome === 'manual');

/**
 * The banner on a conversation whose latest turn ended on a provider usage
 * limit. It reads the server's recovery projection and renders only what that
 * projection says is still actionable: a settled stop never offers Resume now
 * or Cancel again. `active` is the snapshot's verdict that the conversation is
 * limited, and `refreshKey` changes with each snapshot update, which is the
 * only reason it re-reads besides the reset time passing.
 */
export function UsageLimitBanner({
  apiBase,
  scope,
  threadId,
  active,
  refreshKey,
}: {
  apiBase: string;
  scope: ApiRequestScope | undefined;
  threadId: string;
  active: boolean;
  refreshKey?: string | number;
}) {
  const { recovery, refetch, resume, cancel } = useUsageLimitRecovery({
    apiBase,
    scope,
    threadId,
    enabled: active,
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [notice, setNotice] = useState<ConnectionRecoveryOutcomeReason | null>(
    null,
  );
  const wasWaiting = useRef(false);
  const titleId = useId();

  const firstRefresh = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger.
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    if (active) void refetch();
  }, [refreshKey]);

  const dueMs = recovery?.dueAt ? Date.parse(recovery.dueAt) : Number.NaN;
  useEffect(() => {
    if (!active || !Number.isFinite(dueMs)) return;
    const wait = dueMs - Date.now();
    if (wait <= 0) {
      setNowMs(Date.now());
      return;
    }
    // The server arms only within a day; a larger delay would overflow the
    // timer and fire at once.
    if (wait > MAX_TIMER_MS) return;
    const timer = setTimeout(() => {
      setNowMs(Date.now());
      void refetch();
    }, wait + SETTLE_MS);
    return () => clearTimeout(timer);
  }, [active, dueMs, refetch]);

  // A stop this view watched go from waiting to retired says why, briefly.
  // A retirement already in the past when the view opened is not news.
  useEffect(() => {
    const waiting = isWaiting(recovery);
    if (
      wasWaiting.current &&
      recovery?.usageLimit &&
      recovery.outcome === 'canceled' &&
      recovery.outcomeReason
    )
      setNotice(recovery.outcomeReason);
    else if (waiting) setNotice(null);
    wasWaiting.current = waiting;
  }, [recovery]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!active) return null;

  if (!isWaiting(recovery)) {
    if (notice)
      return (
        <section
          className="usage-limit-banner usage-limit-banner--notice"
          aria-label="Usage limit"
          data-testid="usage-limit-banner"
        >
          <p className="usage-limit-banner__body" role="status">
            {RETIRED_COPY[notice]}
          </p>
          <div className="usage-limit-banner__actions">
            <Button size="sm" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </div>
        </section>
      );
    if (recovery?.usageLimit && recovery.outcome === 'resumed')
      return (
        <section
          className="usage-limit-banner"
          aria-label="Usage limit"
          data-testid="usage-limit-banner"
        >
          <p className="usage-limit-banner__body" role="status">
            Resuming this conversation…
          </p>
        </section>
      );
    return null;
  }

  const dueKnown = Number.isFinite(dueMs) && recovery?.dueAt !== undefined;
  const resetPassed = dueKnown && dueMs <= nowMs;
  const resetLabel = dueKnown
    ? formatReset(recovery?.dueAt as string, nowMs)
    : undefined;
  const armed = recovery?.outcome === 'armed';
  const autoOn = armed && recovery?.autoResume === true;
  // With automatic resume off, Resume now is the way forward once the reset
  // has passed (the server leaves the stop to the user then).
  const canResume = !armed || autoOn || resetPassed;
  const body = autoOn
    ? `Station will resume this conversation at ${resetLabel}.`
    : armed && !resetPassed
      ? 'Auto-resume is off. Resume it yourself once your limit resets.'
      : dueKnown
        ? 'Auto-resume is off. Resume it yourself.'
        : "Station can't tell when your limit resets, so it won't resume on its own. Resume it yourself when your limit is back.";
  const failed = resume.isError || cancel.isError;
  const busy = resume.isPending || cancel.isPending;

  return (
    <section
      className="usage-limit-banner"
      aria-labelledby={titleId}
      data-testid="usage-limit-banner"
    >
      <p id={titleId} className="usage-limit-banner__title">
        <strong>Usage limit reached</strong>
        {dueKnown ? (
          <>
            {' · '}
            {resetPassed ? 'Reset ' : 'Resets '}
            <time dateTime={recovery?.dueAt}>{resetLabel}</time>
          </>
        ) : null}
      </p>
      <p className="usage-limit-banner__body">{body}</p>
      {failed ? (
        <p className="usage-limit-banner__error" role="alert">
          That didn't go through. Try again.
        </p>
      ) : null}
      <div className="usage-limit-banner__actions">
        {canResume ? (
          <Button
            variant="primary"
            size="sm"
            pending={resume.isPending}
            pendingLabel="Resuming…"
            disabled={busy}
            onClick={() => resume.mutate()}
          >
            Resume now
          </Button>
        ) : null}
        {autoOn ? (
          <Button
            size="sm"
            pending={cancel.isPending}
            pendingLabel="Canceling…"
            disabled={busy}
            onClick={() => cancel.mutate()}
          >
            Cancel auto-resume
          </Button>
        ) : null}
      </div>
    </section>
  );
}
