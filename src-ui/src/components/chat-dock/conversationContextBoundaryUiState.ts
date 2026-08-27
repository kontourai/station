import type {
  ConversationContextBoundaryProjection,
  ConversationContextBoundaryStatus,
} from '@kontourai/station-contracts/conversation-context-boundary';

type StoredBoundary = Pick<
  ConversationContextBoundaryProjection,
  | 'boundaryId'
  | 'conversationId'
  | 'policy'
  | 'status'
  | 'priorTranscriptInjected'
> & { idempotencyKey: string };

const KEY_PREFIX = 'station.conversation-context-boundary.v1:';

function key(conversationId: string) {
  return `${KEY_PREFIX}${encodeURIComponent(conversationId)}`;
}

function isStatus(value: unknown): value is ConversationContextBoundaryStatus {
  return (
    value === 'reserved' ||
    value === 'claimed' ||
    value === 'consumed' ||
    value === 'cancelled' ||
    value === 'failed' ||
    value === 'indeterminate'
  );
}

function parse(
  value: string | null,
  conversationId: string,
): StoredBoundary | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof candidate.boundaryId !== 'string' ||
      typeof candidate.idempotencyKey !== 'string' ||
      candidate.conversationId !== conversationId ||
      (candidate.policy !== 'continue-from-history' &&
        candidate.policy !== 'empty-next-cold-start') ||
      !isStatus(candidate.status) ||
      typeof candidate.priorTranscriptInjected !== 'boolean'
    )
      return null;
    return candidate as StoredBoundary;
  } catch {
    return null;
  }
}

/** Storage is an acceleration for reconciliation, never authority or transcript content. */
export function readConversationContextBoundaryUiState(
  conversationId: string,
): StoredBoundary | null {
  try {
    return parse(
      window.localStorage.getItem(key(conversationId)),
      conversationId,
    );
  } catch {
    return null;
  }
}

/** Keeps only opaque ids and the server-safe projection; no transcript bytes enter storage. */
export function writeConversationContextBoundaryUiState(
  idempotencyKey: string,
  boundary: ConversationContextBoundaryProjection,
): StoredBoundary | null {
  if (boundary.status === 'consumed' || boundary.status === 'cancelled') {
    clearConversationContextBoundaryUiState(boundary.conversationId);
    return null;
  }
  const stored: StoredBoundary = {
    idempotencyKey,
    boundaryId: boundary.boundaryId,
    conversationId: boundary.conversationId,
    policy: boundary.policy,
    status: boundary.status,
    priorTranscriptInjected: boundary.priorTranscriptInjected,
  };
  try {
    window.localStorage.setItem(
      key(boundary.conversationId),
      JSON.stringify(stored),
    );
  } catch {
    // A storage denial does not turn a server-backed intent into a new one.
  }
  return stored;
}

export function clearConversationContextBoundaryUiState(
  conversationId: string,
): void {
  try {
    window.localStorage.removeItem(key(conversationId));
  } catch {
    // The durable server projection still reconciles on the next available read.
  }
}

export function contextBoundaryUiStorageKey(conversationId: string): string {
  return key(conversationId);
}
