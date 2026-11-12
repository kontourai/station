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
import { useConversationContextBoundaryStatusQuery } from '@kontourai/station-sdk';
import {
  cancelConversationContextBoundary,
  reserveConversationContextBoundary,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useRef, useState } from 'react';
import type { ChatSession } from '../../types';
import { userFacingErrorMessage } from '../../utils/errorText';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type { ConversationContextBoundaryEligibility } from './conversationContextBoundaryEligibility';
import { conversationContextBoundaryEligibility } from './conversationContextBoundaryEligibility';
import {
  readConversationContextBoundaryUiState,
  writeConversationContextBoundaryUiState,
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
  const [stored, setStored] = useState(() =>
    readConversationContextBoundaryUiState(conversationId),
  );
  // A reopened dialog shows the reset already chosen, not the default.
  const [policy, setPolicy] = useState<ConversationContextBoundaryPolicy>(
    () => stored?.policy ?? 'empty-next-cold-start',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [stopNote, setStopNote] = useState<string>();
  const onReservedRef = useRef(onReserved);
  onReservedRef.current = onReserved;
  useEffect(() => {
    setStored(readConversationContextBoundaryUiState(conversationId));
  }, [conversationId]);
  const status = useConversationContextBoundaryStatusQuery(
    conversationId,
    stored?.idempotencyKey ?? '',
    apiBase,
    { enabled: Boolean(stored), refetchInterval: 2_000 },
  );
  const boundary = status.data;
  useEffect(() => {
    if (!boundary || !stored) return;
    if (
      boundary.status === stored.status &&
      boundary.policy === stored.policy &&
      boundary.boundaryId === stored.boundaryId
    )
      return;
    const next = writeConversationContextBoundaryUiState(
      stored.idempotencyKey,
      boundary,
    );
    setStored(next);
    setPolicy(boundary.policy);
    onReservedRef.current(boundary, stored.idempotencyKey);
  }, [boundary, stored]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;
      setStored(readConversationContextBoundaryUiState(conversationId));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [conversationId]);
  const statusValue = boundary?.status ?? stored?.status;
  const claimedOrIndeterminate =
    statusValue === 'claimed' || statusValue === 'indeterminate';
  const canCancel = statusValue === 'reserved' && Boolean(stored);
  // A held reservation keeps its idempotency key, and the server refuses that
  // key with a different policy; change the choice by cancelling first.
  const choiceLocked =
    pending ||
    statusValue === 'reserved' ||
    statusValue === 'claimed' ||
    statusValue === 'indeterminate' ||
    statusValue === 'failed';
  const reserve = async () => {
    if (pending || eligibility.kind !== 'reserve' || claimedOrIndeterminate)
      return;
    setPending(true);
    setError(undefined);
    try {
      const idempotencyKey = stored?.idempotencyKey ?? randomCorrelationId();
      const result = await reserveConversationContextBoundary(
        apiBase,
        conversationId,
        {
          policy,
          expectedCurrentSessionId: sessionId,
          idempotencyKey,
        },
      );
      setStored(
        writeConversationContextBoundaryUiState(idempotencyKey, result),
      );
      onReserved(result, idempotencyKey);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? userFacingErrorMessage(cause)
          : "Couldn't reset the agent context.",
      );
    } finally {
      setPending(false);
    }
  };
  const stopThenReserve = async () => {
    if (pending || eligibility.kind !== 'stop-session') return;
    setPending(true);
    setError(undefined);
    setStopNote(undefined);
    try {
      const {
        dispatchOrchestrationCommandWithReceipt,
        STOP_REQUEST_BUDGET_MS,
      } = await import('@kontourai/station-sdk');
      await dispatchOrchestrationCommandWithReceipt(
        { type: 'stopSession', threadId: sessionId },
        apiBase,
        STOP_REQUEST_BUDGET_MS,
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
      setStopNote('Agent stopped.');
      const idempotencyKey = stored?.idempotencyKey ?? randomCorrelationId();
      const result = await reserveConversationContextBoundary(
        apiBase,
        conversationId,
        {
          policy,
          expectedCurrentSessionId: sessionId,
          idempotencyKey,
        },
      );
      setStored(
        writeConversationContextBoundaryUiState(idempotencyKey, result),
      );
      onReserved(result, idempotencyKey);
    } catch (cause) {
      const detail =
        cause instanceof Error ? userFacingErrorMessage(cause) : '';
      setError(
        `Station couldn't confirm the agent stopped${detail ? `: ${detail}` : '.'} Nothing was reset.`,
      );
    } finally {
      setPending(false);
    }
  };
  const cancel = async () => {
    if (!stored || !canCancel || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await cancelConversationContextBoundary(
        apiBase,
        conversationId,
        stored.idempotencyKey,
      );
      setStored(
        writeConversationContextBoundaryUiState(stored.idempotencyKey, result),
      );
      onReserved(result, stored.idempotencyKey);
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
        {statusValue && (
          <p role="status">
            {statusValue === 'reserved'
              ? `Ready. On your next message the agent ${describeNextStart(boundary?.policy ?? stored?.policy ?? policy)}.`
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
        {eligibility.kind !== 'reserve' && (
          <p role="alert">{eligibility.reason}</p>
        )}
        {stopNote && <p role="status">{stopNote}</p>}
        {error && <p role="alert">{error}</p>}
        {eligibility.kind === 'reserve' && (
          <button
            type="button"
            onClick={reserve}
            disabled={pending || claimedOrIndeterminate}
          >
            {pending
              ? 'Applying…'
              : stored
                ? 'Retry reset'
                : 'Reset agent context'}
          </button>
        )}
        {eligibility.kind === 'stop-session' && !statusValue && (
          <button type="button" onClick={stopThenReserve} disabled={pending}>
            {pending ? 'Stopping agent…' : 'Stop agent and reset'}
          </button>
        )}
        {canCancel && (
          <button type="button" onClick={cancel} disabled={pending}>
            Cancel reset
          </button>
        )}
      </div>
    </ResponsiveDialogSurface>
  );
}
