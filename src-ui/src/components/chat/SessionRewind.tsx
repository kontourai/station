import type {
  SessionRewindOutcome,
  SessionRewindRefusalReason,
} from '@kontourai/station-contracts/provider';
import {
  useRewindSessionToTurnMutation,
  useSessionLiveContinuityQuery,
} from '@kontourai/station-sdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { userFacingErrorMessage } from '../../utils/errorText';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { ConfirmModal } from '../modals/ConfirmModal';

/** A user turn a rewind can target: the live session that ran it, and its id. */
export interface SessionRewindTarget {
  sessionId: string;
  turnId: string;
}

interface SessionRewindPort {
  /** The turn this row can rewind to before, or undefined when none is offered. */
  targetFor(row: {
    sessionId?: string;
    turnId?: string;
    rewound?: boolean;
  }): SessionRewindTarget | undefined;
  request(target: SessionRewindTarget): void;
}

const SessionRewindContext = createContext<SessionRewindPort | null>(null);

/** What a user row's menu offers: a handler, only where a rewind can apply. */
export function useSessionRewindAction(row: {
  role: string;
  sessionId?: string;
  turnId?: string;
  rewound?: boolean;
}): (() => void) | undefined {
  const port = useContext(SessionRewindContext);
  const target = row.role === 'user' ? port?.targetFor(row) : undefined;
  return port && target ? () => port.request(target) : undefined;
}

const REFUSAL_TEXT: Readonly<Record<SessionRewindRefusalReason, string>> = {
  unsupported: 'This agent cannot rewind its conversation.',
  'not-live': 'The agent is no longer running this conversation.',
  'turn-running': 'Stop the running turn, then rewind.',
  'unknown-turn':
    'The agent cannot rewind to this message. It may be from before a restart.',
};

/** What to tell the person when a rewind did not happen. */
export function sessionRewindFailureText(
  outcome: Exclude<SessionRewindOutcome, { kind: 'rewound' }>,
): string {
  return outcome.kind === 'refused'
    ? REFUSAL_TEXT[outcome.reason]
    : `The agent did not rewind: ${outcome.message}`;
}

/**
 * Offers "Rewind conversation to here" on the user turns of the live
 * execution session, only while that session's engine declares an in-place
 * rewind (`GET …/continuity`). The rewind hides the turn and every later one
 * from the engine; the transcript keeps them, and the stored marker event
 * draws them as rewound. It is not checkpoint restore: files change only as
 * the engine itself restores them, and the marker says how many it did.
 */
export function SessionRewindProvider({
  executionThreadId,
  openTurnId,
  children,
}: {
  /** The session that holds the engine now; absent on a read-only view. */
  executionThreadId: string | undefined;
  /**
   * The conversation's open turn, when one is open. A turn's start is when
   * an idle session's engine comes back, and its end is when a rewind can
   * run, so each change re-reads the continuity.
   */
  openTurnId?: string;
  children: ReactNode;
}) {
  const connection = useOptionalConversationConnection();
  const apiBase = connection?.apiBase;
  const continuity = useSessionLiveContinuityQuery(executionThreadId, apiBase, {
    readTarget: connection?.station,
  });
  const { refetch: refetchContinuity } = continuity;
  const firstTurnRead = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `openTurnId` is the trigger, not an input; each change re-reads.
  useEffect(() => {
    // Mounting already read it; only a later change re-reads.
    if (firstTurnRead.current) {
      firstTurnRead.current = false;
      return;
    }
    if (executionThreadId) void refetchContinuity();
  }, [openTurnId, executionThreadId, refetchContinuity]);
  const rewind = useRewindSessionToTurnMutation(
    apiBase,
    connection?.requestScope,
  );
  const [pending, setPending] = useState<SessionRewindTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offered =
    continuity.data?.live === true && continuity.data.rewind === 'in-place';
  const targetFor = useCallback<SessionRewindPort['targetFor']>(
    (row) =>
      offered &&
      executionThreadId &&
      row.sessionId === executionThreadId &&
      row.turnId &&
      row.rewound !== true
        ? { sessionId: row.sessionId, turnId: row.turnId }
        : undefined,
    [offered, executionThreadId],
  );
  const port = useMemo<SessionRewindPort>(
    () => ({
      targetFor,
      request: (target) => {
        setError(null);
        setPending(target);
      },
    }),
    [targetFor],
  );
  const { mutateAsync, isPending } = rewind;
  const confirm = () => {
    if (!pending) return;
    void mutateAsync({ threadId: pending.sessionId, turnId: pending.turnId })
      .then((outcome) => {
        if (outcome.kind === 'rewound') {
          setPending(null);
          return;
        }
        setError(sessionRewindFailureText(outcome));
        // A refusal can mean the session changed under the menu.
        void continuity.refetch();
      })
      .catch((cause: unknown) => setError(userFacingErrorMessage(cause)));
  };
  return (
    <SessionRewindContext.Provider value={port}>
      {children}
      <ConfirmModal
        isOpen={pending !== null}
        title="Rewind conversation to here?"
        message="The agent forgets this message and everything after it. They stay in the chat, marked rewound. The agent may restore files its tools changed since then."
        confirmLabel="Rewind"
        variant="warning"
        pending={isPending}
        error={error}
        onConfirm={confirm}
        onCancel={() => {
          setPending(null);
          setError(null);
        }}
      />
    </SessionRewindContext.Provider>
  );
}
