import {
  type ConversationContextBoundaryPolicy,
  type ConversationContextBoundaryProjection,
} from '@kontourai/station-contracts/conversation-context-boundary';
import {
  foldedSessionLifecycleState,
  isSessionLifecycleStateStopped,
} from '@kontourai/station-contracts/session-lifecycle';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useConversationContextBoundaryStatusQuery } from '@kontourai/station-sdk';
import {
  cancelConversationContextBoundary,
  reserveConversationContextBoundary,
} from '@kontourai/station-sdk/client';
import { useEffect, useRef, useState } from 'react';
import type { ChatSession } from '../../types';
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
          reason: 'Station has no current Session to replace.',
        });
  const [policy, setPolicy] = useState<ConversationContextBoundaryPolicy>(
    'empty-next-cold-start',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [stopReceipt, setStopReceipt] = useState<string>();
  const [stored, setStored] = useState(() =>
    readConversationContextBoundaryUiState(conversationId),
  );
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
  const reserve = async () => {
    if (pending || eligibility.kind !== 'reserve' || claimedOrIndeterminate)
      return;
    setPending(true);
    setError(undefined);
    try {
      const idempotencyKey = stored?.idempotencyKey ?? crypto.randomUUID();
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
          ? cause.message
          : 'Could not replace the engine context.',
      );
    } finally {
      setPending(false);
    }
  };
  const stopThenReserve = async () => {
    if (pending || eligibility.kind !== 'stop-session') return;
    setPending(true);
    setError(undefined);
    setStopReceipt(undefined);
    try {
      const {
        dispatchOrchestrationCommandWithReceipt,
        STOP_REQUEST_BUDGET_MS,
      } = await import('@kontourai/station-sdk');
      const stopped = await dispatchOrchestrationCommandWithReceipt(
        { type: 'stopSession', threadId: sessionId },
        apiBase,
        STOP_REQUEST_BUDGET_MS,
      );
      setStopReceipt(`Stop receipt ${stopped.receipt.commandId} received.`);
      const refreshed = await onStoppedSessionRefreshed();
      if (
        !refreshed ||
        !isSessionLifecycleStateStopped(
          foldedSessionLifecycleState(refreshed.lifecycleState),
        ) ||
        refreshed.hasActiveTurn
      ) {
        setError(
          'Station has not confirmed that the current Session is stopped. No context boundary was reserved.',
        );
        return;
      }
      const idempotencyKey = stored?.idempotencyKey ?? crypto.randomUUID();
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
      const detail = cause instanceof Error ? cause.message : '';
      setError(
        `Station did not confirm that the current Session stopped${detail ? `: ${detail}` : '.'} No context boundary was reserved.`,
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
          ? cause.message
          : 'Could not cancel the context replacement.',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <ResponsiveDialogSurface
      ariaLabel="Replace engine context"
      onClose={pending ? () => {} : onClose}
      historyMode="entry"
    >
      <header className="responsive-dialog__header">
        <h2>Replace engine context</h2>
        <ResponsiveDialogCloseButton
          label="Close context reset"
          disabled={pending}
          onClick={onClose}
        />
      </header>
      <div className="responsive-dialog__body">
        <p>
          The readable transcript, Task links, and evidence stay. For an open
          Session, Station stops the current engine context first; it reserves
          the next engine context only after confirming that stop.
        </p>
        <label>
          <input
            type="radio"
            checked={policy === 'continue-from-history'}
            onChange={() => setPolicy('continue-from-history')}
            disabled={pending}
          />{' '}
          Continue from durable history
        </label>
        <label>
          <input
            type="radio"
            checked={policy === 'empty-next-cold-start'}
            onChange={() => setPolicy('empty-next-cold-start')}
            disabled={pending}
          />{' '}
          Start next engine context empty
        </label>
        {policy === 'empty-next-cold-start' && (
          <p>
            Omitted: provider-native history, tool state, and session approvals.
            Preserved: Agent and safety policy, tools/skills, and your next
            message.
          </p>
        )}
        {statusValue && (
          <p role="status">
            {statusValue === 'reserved'
              ? `Next engine start: ${policy === 'empty-next-cold-start' ? 'Empty' : 'Re-anchor'}`
              : statusValue === 'claimed'
                ? 'The next engine start may already be in progress. Repeat and cancel are disabled while Station reconciles it.'
                : statusValue === 'indeterminate'
                  ? 'Station cannot prove whether the next engine start happened. Repeat and cancel are disabled; inspect the conversation before continuing.'
                  : statusValue === 'failed'
                    ? 'The prior engine start failed before acceptance. You can retry this same context replacement.'
                    : 'The context replacement reached a terminal state.'}
          </p>
        )}
        {eligibility.kind !== 'reserve' && (
          <p role="alert">{eligibility.reason}</p>
        )}
        {stopReceipt && <p role="status">{stopReceipt}</p>}
        {error && <p role="alert">{error}</p>}
        {eligibility.kind === 'reserve' && (
          <button
            type="button"
            onClick={reserve}
            disabled={pending || claimedOrIndeterminate}
          >
            {pending
              ? 'Reserving…'
              : stored
                ? 'Retry context replacement'
                : 'Replace engine context'}
          </button>
        )}
        {eligibility.kind === 'stop-session' && !statusValue && (
          <button type="button" onClick={stopThenReserve} disabled={pending}>
            {pending ? 'Stopping current Session…' : 'Stop current Session'}
          </button>
        )}
        {canCancel && (
          <button type="button" onClick={cancel} disabled={pending}>
            Cancel context replacement
          </button>
        )}
      </div>
    </ResponsiveDialogSurface>
  );
}
