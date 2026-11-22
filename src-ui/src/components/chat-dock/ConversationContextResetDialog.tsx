import {
  type ConversationContextBoundaryPolicy,
  type ConversationContextBoundaryProjection,
  isSummaryContextBoundary,
} from '@kontourai/station-contracts/conversation-context-boundary';
import {
  foldedSessionLifecycleState,
  isSessionLifecycleStateAtRest,
} from '@kontourai/station-contracts/session-lifecycle';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { isProvablyNotSent } from '@kontourai/station-sdk';
import {
  ChatHttpError,
  cancelConversationContextBoundary,
  reserveConversationContextBoundary,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatSession } from '../../types';
import { userFacingErrorMessage } from '../../utils/errorText';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type { ConversationContextBoundaryEligibility } from './conversationContextBoundaryEligibility';
import { conversationContextBoundaryEligibility } from './conversationContextBoundaryEligibility';
import {
  type ContextBoundaryAuthority,
  type ContextBoundaryScope,
  forgetContextBoundaryIntent,
  observeContextBoundary,
  rememberContextBoundaryIntent,
  useContextBoundaryRecovery,
} from './conversationContextBoundaryUiState';

function describeNextStart(policy: ConversationContextBoundaryPolicy) {
  if (policy === 'empty-next-cold-start') return 'starts fresh';
  return isSummaryContextBoundary(policy)
    ? 'continues from a summary'
    : 'continues from chat history';
}

export function ConversationContextResetDialog({
  apiBase,
  conversationId,
  sessionId,
  authority,
  eligibility: suppliedEligibility,
  session,
  sessionRead,
  orchestrationSession,
  hasLocalDeferredMessages = false,
  onStoppedSessionRefreshed,
  onReserved,
  onClose,
}: {
  apiBase: string;
  conversationId: string;
  sessionId: string;
  authority?: ContextBoundaryAuthority;
  /** Test-only override; production derives this in the lazy dialog. */
  eligibility?: ConversationContextBoundaryEligibility;
  session?: ChatSession;
  sessionRead?: 'pending' | 'error' | 'present' | 'absent';
  orchestrationSession?: OrchestrationSessionSummary | null;
  hasLocalDeferredMessages?: boolean;
  /** Re-read the serving Station after its Stop receipt before reserving. */
  onStoppedSessionRefreshed: () => Promise<OrchestrationSessionSummary | null>;
  onReserved: (
    boundary: ConversationContextBoundaryProjection,
    idempotencyKey: string,
  ) => void;
  onClose: () => void;
}) {
  const eligibility =
    suppliedEligibility ??
    (session && sessionRead && orchestrationSession !== undefined
      ? conversationContextBoundaryEligibility({
          session,
          sessionRead,
          orchestrationSession,
          hasLocalDeferredMessages,
        })
      : {
          kind: 'blocked' as const,
          reason: 'Send a message first.',
        });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const scope = authority && {
    ...authority,
    conversationId,
    sessionId,
    isCurrent: () => mounted.current && authority.isCurrent(),
  };
  const { candidate, boundary, refetch, refreshCurrent } =
    useContextBoundaryRecovery(scope, apiBase);
  const stored = candidate?.legacy ? undefined : candidate;
  const [selectedPolicy, setPolicy] = useState<
    'continue-from-history' | 'empty-next-cold-start'
  >('empty-next-cold-start');
  const policy =
    stored?.policy ??
    (boundary?.policy === 'continue-from-history'
      ? boundary.policy
      : selectedPolicy);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [stopNote, setStopNote] = useState(false);
  const lastPublication = useRef<
    { state: string; idempotencyKey: string } | undefined
  >(undefined);
  const onReservedRef = useRef(onReserved);
  onReservedRef.current = onReserved;

  const publish = useCallback(
    (
      target: ContextBoundaryScope,
      intent: NonNullable<typeof candidate>,
      result: ConversationContextBoundaryProjection,
    ) => {
      const publication = `${target.namespace}:${result.boundaryId}:${result.status}`;
      if (lastPublication.current?.state === publication) return;
      if (!observeContextBoundary(target, intent, result)) return;
      lastPublication.current = {
        state: publication,
        idempotencyKey: intent.idempotencyKey,
      };
      setError(undefined);
      onReservedRef.current(result, intent.idempotencyKey);
    },
    [],
  );

  useEffect(() => {
    if (scope && candidate && boundary) publish(scope, candidate, boundary);
  }, [scope, candidate, boundary, publish]);

  const statusValue = boundary?.status;
  const canCancel = statusValue === 'reserved' && Boolean(candidate);
  const choiceLocked = pending || Boolean(stored || boundary);
  const couldRetry = !statusValue || statusValue === 'failed';
  const requestOptions = authority?.requestScope
    ? { requestScope: authority.requestScope }
    : undefined;

  const reserveBoundary = async (stopped: boolean) => {
    if (!scope?.isCurrent()) return;
    const intent = stored ?? {
      idempotencyKey: randomCorrelationId(),
      policy,
      ...(stopped ? { stopped: true } : {}),
    };
    if (!rememberContextBoundaryIntent(scope, intent)) {
      setError('Station could not save the reset request on this device.');
      return;
    }
    try {
      const result = await reserveConversationContextBoundary(
        apiBase,
        conversationId,
        {
          policy: intent.policy,
          expectedCurrentSessionId: sessionId,
          idempotencyKey: intent.idempotencyKey,
        },
        requestOptions,
      );
      publish(scope, intent, result);
    } catch (cause) {
      if (
        lastPublication.current?.idempotencyKey === intent.idempotencyKey &&
        !statusValue
      )
        return;
      const refused =
        cause instanceof ChatHttpError &&
        cause.stationEnvelope &&
        cause.status >= 400 &&
        cause.status < 500;
      const notSent = isProvablyNotSent(cause);
      const validationRefused =
        refused &&
        cause.status === 400 &&
        typeof cause.details === 'object' &&
        cause.details !== null &&
        'fieldErrors' in cause.details;
      // A transport can replay the POST after losing its first response. A
      // later conflict only reports the replay, so keep its original key.
      let canRetire = !stored && (validationRefused || notSent);
      if (stored && statusValue === 'failed' && (refused || notSent)) {
        // A different tab may have started the reserved successor since the
        // failed status was shown. Check again before retiring its local key.
        const current = await refreshCurrent();
        canRetire =
          !current.isError &&
          current.data?.status === 'failed' &&
          observeContextBoundary(scope, intent, current.data);
      }
      if (canRetire && (refused || notSent))
        forgetContextBoundaryIntent(scope, intent.idempotencyKey);
      if (!scope.isCurrent()) return;
      setError(
        canRetire && refused
          ? userFacingErrorMessage(cause)
          : canRetire && notSent
            ? "Station didn't send the reset request."
            : "Station couldn't confirm the reset. Check its status before continuing.",
      );
    }
  };

  const reserve = async () => {
    if (pending || eligibility.kind !== 'reserve' || !couldRetry) return;
    setPending(true);
    setError(undefined);
    try {
      await reserveBoundary(false);
    } finally {
      setPending(false);
    }
  };

  const stopThenReserve = async () => {
    if (
      pending ||
      eligibility.kind !== 'stop-session' ||
      !scope?.isCurrent() ||
      stored
    )
      return;
    setPending(true);
    setError(undefined);
    setStopNote(false);
    try {
      try {
        const {
          dispatchOrchestrationCommandWithReceipt,
          STOP_REQUEST_BUDGET_MS,
        } = await import('@kontourai/station-sdk');
        if (!scope.isCurrent()) return;
        await dispatchOrchestrationCommandWithReceipt(
          { type: 'stopSession', threadId: sessionId },
          apiBase,
          STOP_REQUEST_BUDGET_MS,
          requestOptions,
        );
        const refreshed = await onStoppedSessionRefreshed();
        if (
          !refreshed ||
          !isSessionLifecycleStateAtRest(
            foldedSessionLifecycleState(refreshed.lifecycleState),
          ) ||
          refreshed.hasActiveTurn
        ) {
          setError(
            "Station couldn't confirm the agent stopped. Nothing was reset.",
          );
          return;
        }
      } catch (cause) {
        const detail =
          cause instanceof Error ? userFacingErrorMessage(cause) : '';
        setError(
          `Station couldn't confirm the agent stopped${detail ? `: ${detail}` : '.'} Nothing was reset.`,
        );
        return;
      }
      setStopNote(true);
      await reserveBoundary(true);
    } finally {
      setPending(false);
    }
  };

  const cancel = async () => {
    if (!scope?.isCurrent() || !candidate || !canCancel || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await cancelConversationContextBoundary(
        apiBase,
        conversationId,
        candidate.idempotencyKey,
        requestOptions,
      );
      publish(scope, candidate, result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? userFacingErrorMessage(cause)
          : "Couldn't cancel the reset.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <ResponsiveDialogSurface
      layer="dialog"
      ariaLabel="Reset agent context"
      onClose={pending ? () => {} : onClose}
      historyMode="entry"
    >
      <header className="responsive-dialog__header">
        <h2>Reset agent context</h2>
        <ResponsiveDialogCloseButton
          label="Close context reset"
          disabled={pending}
          onClick={onClose}
        />
      </header>
      <div className="responsive-dialog__body">
        <p>
          Your chat history, Task links and evidence stay. If the agent is
          running, it's stopped first.
        </p>
        <label>
          <input
            type="radio"
            checked={policy === 'continue-from-history'}
            onChange={() => setPolicy('continue-from-history')}
            disabled={choiceLocked}
          />{' '}
          Continue with chat history
        </label>
        <label>
          <input
            type="radio"
            checked={policy === 'empty-next-cold-start'}
            onChange={() => setPolicy('empty-next-cold-start')}
            disabled={choiceLocked}
          />{' '}
          Start fresh (agent forgets this chat)
        </label>
        {policy === 'empty-next-cold-start' && (
          <p>
            The agent also loses its tool state and approvals. It keeps its
            instructions, safety policy, tools, skills and your next message.
          </p>
        )}
        {stored && !statusValue && (
          <p role="status">Checking the original reset request.</p>
        )}
        {statusValue && (
          <p role="status">
            {statusValue === 'reserved'
              ? `Ready. On your next message the agent ${describeNextStart(boundary?.policy ?? policy)}.`
              : statusValue === 'claimed'
                ? "Starting the agent's next context. You can't cancel now."
                : statusValue === 'indeterminate'
                  ? "Station couldn't confirm whether the agent restarted. Check the chat before continuing."
                  : statusValue === 'failed'
                    ? 'The reset failed before the agent started. You can retry it.'
                    : statusValue === 'cancelled'
                      ? 'Reset cancelled.'
                      : 'Reset applied.'}
          </p>
        )}
        {eligibility.kind !== 'reserve' && !stored && !statusValue && (
          <p role="alert">{eligibility.reason}</p>
        )}
        {(stopNote || stored?.stopped) && <p role="status">Agent stopped.</p>}
        {!scope && (
          <p role="alert">
            Reconnect to the Station to check or reset agent context.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <ActionRow
          overflowLabel="More reset actions"
          primary={
            eligibility.kind === 'reserve' && couldRetry ? (
              <Button onClick={reserve} disabled={pending || !scope}>
                {pending
                  ? 'Applying…'
                  : stored
                    ? 'Retry reset'
                    : 'Reset agent context'}
              </Button>
            ) : eligibility.kind === 'stop-session' &&
              !statusValue &&
              !stored ? (
              <Button onClick={stopThenReserve} disabled={pending || !scope}>
                {pending ? 'Stopping agent…' : 'Stop agent and reset'}
              </Button>
            ) : undefined
          }
          secondary={
            canCancel ? (
              <Button onClick={cancel} disabled={pending} variant="secondary">
                Cancel reset
              </Button>
            ) : stored && !statusValue && !pending ? (
              <Button onClick={refetch} variant="secondary">
                Check reset status
              </Button>
            ) : undefined
          }
        />
      </div>
    </ResponsiveDialogSurface>
  );
}
