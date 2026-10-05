import type {
  ConnectionRecoveryOutcomeReason,
  ConnectionRecoveryProjection,
} from '@kontourai/station-contracts/connection-recovery';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useEffect, useId, useRef, useState } from 'react';
import { useUsageLimitRecovery } from '../../hooks/useUsageLimitRecovery';
import type { ChatSession } from '../../types';
import { clockTime } from '../../utils/relativeTime';
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

/**
 * What a stop that was waiting (or being resumed) settled into, in words. Every
 * outcome that ends a wait says so: nothing settles silently. `succeeded` is
 * the resumed turn's own result, which the conversation shows.
 */
function settledNotice(recovery: ConnectionRecoveryProjection): string | null {
  switch (recovery.outcome) {
    case 'canceled':
      return recovery.outcomeReason
        ? RETIRED_COPY[recovery.outcomeReason]
        : 'Auto-resume was canceled.';
    case 'failed':
      return "Resume didn't go through. Send a message to continue.";
    case 'indeterminate':
    case 'compensation-required':
      return 'Resume may not have gone through. Check the conversation before trying again.';
    default:
      return null;
  }
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
  session,
  summary,
}: {
  apiBase: string;
  scope: ApiRequestScope | undefined;
  session: ChatSession;
  summary: OrchestrationSessionSummary | null | undefined;
}) {
  // The Session the limit stopped: the dock's own correlation (see
  // `useChatDockViewModel`), so the banner reads the intent the server armed.
  const threadId =
    summary?.threadId ??
    (session.currentSessionId || session.conversationId || session.id);
  // The chat's own hold flag (live `runtime.error`, snapshots) or the server
  // summary the dock already holds. A chat opened fresh gets no snapshot after
  // it exists, so the flag alone would miss a limit that stopped it earlier.
  const active =
    session.usageLimitStopped === true ||
    (summary?.lastEventMethod === 'runtime.error' &&
      summary.lastRuntimeErrorUsageLimit === true);
  const refreshKey = `${summary?.eventCount ?? ''}:${summary?.updatedAt ?? ''}`;
  return (
    <UsageLimitBannerFor
      key={threadId}
      apiBase={apiBase}
      scope={scope}
      threadId={threadId}
      active={active}
      refreshKey={refreshKey}
    />
  );
}

function UsageLimitBannerFor({
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
  refreshKey: string;
}) {
  // A banner that showed a waiting or resuming stop keeps reading until that
  // stop settles, even after the conversation stops looking limited (a newer
  // message clears the hold), so the reason it settled for can be said.
  const [engaged, setEngaged] = useState(false);
  const enabled = active || engaged;
  const { recovery, refetch, resume, cancel } = useUsageLimitRecovery({
    apiBase,
    scope,
    threadId,
    enabled,
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const wasEngaged = useRef(false);
  const titleId = useId();

  const firstRefresh = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger.
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    if (enabled) void refetch();
  }, [refreshKey]);

  const dueMs = recovery?.dueAt ? Date.parse(recovery.dueAt) : Number.NaN;
  useEffect(() => {
    if (!enabled || !Number.isFinite(dueMs)) return;
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
  }, [enabled, dueMs, refetch]);

  // A stop this view watched wait, and that a read then shows no longer
  // waiting, says how it settled, briefly: that one read is the last. Engaging
  // only while the stop waits keeps a resumed stop (which a Claude or Codex
  // turn never moves past `resumed`) from re-reading on every summary update.
  // A settlement already in the past when the view opened is not news.
  useEffect(() => {
    if (recovery?.usageLimit === true && isWaiting(recovery)) {
      wasEngaged.current = true;
      setEngaged(true);
      setNotice(null);
      return;
    }
    if (!wasEngaged.current || recovery?.usageLimit !== true) return;
    // `resumed` is not an ending: the dispatch is in flight and can still end
    // failed, indeterminate or canceled. Reads stop being forced, but the next
    // natural one (the hold coming back on, or a summary update while active)
    // still says how it ended.
    setEngaged(false);
    if (recovery.outcome === 'resumed') return;
    wasEngaged.current = false;
    setNotice(settledNotice(recovery));
  }, [recovery]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (notice)
    return (
      <section
        className="usage-limit-banner usage-limit-banner--notice"
        aria-label="Usage limit"
        data-testid="usage-limit-banner"
      >
        <p className="usage-limit-banner__body" role="status">
          {notice}
        </p>
        <div className="usage-limit-banner__actions">
          <Button size="sm" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      </section>
    );

  // The actions and the resuming line speak for a conversation that still
  // looks limited; once a newer turn has started they would be stale.
  if (!active) return null;

  if (!isWaiting(recovery)) {
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
    ? clockTime(Date.parse(recovery?.dueAt as string), nowMs)
    : undefined;
  const autoOn = recovery?.outcome === 'armed' && recovery.autoResume === true;
  // The reset time is said once, in the title. Resume now is always offered:
  // before the reset it may be refused again, and the wait then carries on.
  const body = autoOn
    ? 'Station will resume this conversation automatically.'
    : dueKnown && !resetPassed
      ? 'Auto-resume is off. You can resume now, but your limit may not have reset yet.'
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
