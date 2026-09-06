import type { ConversationContextBoundaryMarker } from './conversation-context-boundary-module.js';
import type { ConversationSessionLineage } from './conversation-session-lineage.js';

/** Identity observed by the existing authorized Session owner, never from a cursor. */
export interface NativeMemorySessionIdentity {
  readonly sessionId: string;
  readonly provider: string;
  readonly connectionId?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly persistSession?: boolean;
  readonly status?: string;
}

export interface NativeMemoryScope {
  readonly provider: 'station-agent';
  readonly connectionId?: string;
  readonly agentId: string;
  readonly userId?: string;
  readonly tenantId?: string;
  readonly projectId?: string;
}

export interface NativeMemoryContinuityOwner {
  conversationForSession(
    sessionId: string,
  ): Readonly<ConversationSessionLineage> | undefined;
  conversationSessions(
    conversationId: string,
  ): readonly Readonly<ConversationSessionLineage>[];
  contextBoundaryForSuccessor(
    sessionId: string,
  ): Readonly<ConversationContextBoundaryMarker> | undefined;
  /** Must apply the captured SessionReadScope, including every canonical predecessor. */
  readSession(sessionId: string): Promise<NativeMemorySessionIdentity | null>;
  isAuthorityCurrent(): boolean | Promise<boolean>;
}

declare const nativeMemoryBindingBrand: unique symbol;
export interface NativeMemoryContinuityBinding {
  readonly [nativeMemoryBindingBrand]: true;
  readonly conversationId: string;
  readonly currentSessionId: string;
  readonly scope: Readonly<NativeMemoryScope>;
  /** Existing native memory IDs, oldest first, including the current child once. */
  readonly sessionIds: readonly string[];
  /** Authorized canonical transcript prefix; never private provider memory. */
  readonly canonicalPrefixSessionIds: readonly string[];
  readonly cutReason:
    | 'start'
    | 'empty-context'
    | 'identity-change'
    | 'native-history-unavailable';
  isCurrent(): Promise<boolean>;
}

const issuedBindings = new WeakSet<object>();
export function isNativeMemoryContinuityBinding(
  value: unknown,
): value is NativeMemoryContinuityBinding {
  return (
    typeof value === 'object' && value !== null && issuedBindings.has(value)
  );
}
export class NativeMemoryContinuityUnavailableError extends Error {
  readonly code = 'native_memory_continuity_unavailable';
  constructor() {
    super(
      'The authorized native conversation history is unavailable or changed.',
    );
  }
}
function fail(): never {
  throw new NativeMemoryContinuityUnavailableError();
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\r\n\0]/.test(value)
  );
}
function scopeSnapshot(value: NativeMemoryScope): Readonly<NativeMemoryScope> {
  if (value.provider !== 'station-agent' || !identifier(value.agentId)) fail();
  for (const key of [
    'connectionId',
    'userId',
    'tenantId',
    'projectId',
  ] as const)
    if (value[key] !== undefined && !identifier(value[key])) fail();
  return Object.freeze({
    provider: 'station-agent',
    agentId: value.agentId,
    ...(value.connectionId !== undefined
      ? { connectionId: value.connectionId }
      : {}),
    ...(value.userId !== undefined ? { userId: value.userId } : {}),
    ...(value.tenantId !== undefined ? { tenantId: value.tenantId } : {}),
    ...(value.projectId !== undefined ? { projectId: value.projectId } : {}),
  });
}
function sameScope(
  value: NativeMemorySessionIdentity,
  scope: NativeMemoryScope,
): boolean {
  return (
    value.provider === scope.provider &&
    value.agentId === scope.agentId &&
    value.connectionId === scope.connectionId &&
    value.userId === scope.userId &&
    value.tenantId === scope.tenantId &&
    value.projectId === scope.projectId
  );
}
function lineageSnapshot(value: Readonly<ConversationSessionLineage>) {
  return {
    conversationId: value.conversationId,
    sessionId: value.sessionId,
    ordinal: value.ordinal,
    predecessorSessionId: value.predecessorSessionId,
    createdAt: value.createdAt,
  };
}
function boundarySnapshot(
  owner: NativeMemoryContinuityOwner,
  row: Readonly<ConversationSessionLineage>,
) {
  const boundary = owner.contextBoundaryForSuccessor(row.sessionId);
  if (!boundary) return null;
  if (
    boundary.conversationId !== row.conversationId ||
    boundary.successorSessionId !== row.sessionId ||
    boundary.predecessorSessionId !== row.predecessorSessionId ||
    !identifier(boundary.boundaryId) ||
    !['reserved', 'claimed', 'consumed', 'failed'].includes(boundary.status) ||
    !['continue-from-history', 'empty-next-cold-start'].includes(
      boundary.policy,
    )
  )
    fail();
  // Claim completion does not change the history decision. Immutable identity,
  // cancellation, indeterminate outcome and policy replacement do change it.
  return {
    boundaryId: boundary.boundaryId,
    conversationId: boundary.conversationId,
    successorSessionId: boundary.successorSessionId,
    predecessorSessionId: boundary.predecessorSessionId,
    policy: boundary.policy,
    actorId: boundary.actorId,
    idempotencyKey: boundary.idempotencyKey,
    createdAt: boundary.createdAt,
  };
}
function identitySnapshot(
  value: NativeMemorySessionIdentity,
  sessionId: string,
): NativeMemorySessionIdentity {
  if (
    value.sessionId !== sessionId ||
    !identifier(value.provider) ||
    (value.persistSession !== undefined &&
      typeof value.persistSession !== 'boolean')
  )
    fail();
  return {
    sessionId,
    provider: value.provider,
    connectionId: value.connectionId,
    agentId: value.agentId,
    userId: value.userId,
    tenantId: value.tenantId,
    projectId: value.projectId,
    persistSession: value.persistSession === false ? false : undefined,
    status: value.status === 'dead' ? 'dead' : undefined,
  };
}

/** Resolve existing lineage and authorized identities. No history is copied or written. */
export async function captureNativeMemoryContinuity(
  input: {
    readonly currentSessionId: string;
    readonly scope: NativeMemoryScope;
  },
  owner: NativeMemoryContinuityOwner,
): Promise<NativeMemoryContinuityBinding> {
  const currentSessionId = input.currentSessionId;
  if (!identifier(currentSessionId)) fail();
  const scope = scopeSnapshot(input.scope);
  const observe = async () => {
    if (!(await owner.isAuthorityCurrent())) fail();
    const current = owner.conversationForSession(currentSessionId);
    if (!current || !identifier(current.conversationId)) fail();
    const conversationId = current.conversationId;
    const lineage = owner
      .conversationSessions(conversationId)
      .map(lineageSnapshot);
    const last = lineage.at(-1);
    if (
      !last ||
      last.sessionId !== currentSessionId ||
      JSON.stringify(lineageSnapshot(current)) !== JSON.stringify(last)
    )
      fail();
    const ids = new Set<string>();
    for (const [index, row] of lineage.entries()) {
      if (
        row.conversationId !== conversationId ||
        !identifier(row.sessionId) ||
        ids.has(row.sessionId) ||
        row.ordinal !== index ||
        row.predecessorSessionId !== lineage[index - 1]?.sessionId
      )
        fail();
      ids.add(row.sessionId);
    }
    // An empty boundary applies across harnesses, not just within the native leg.
    let start = 0;
    let reset = false;
    const boundaries: ReturnType<typeof boundarySnapshot>[] = [];
    for (let index = lineage.length - 1; index >= 0; index--) {
      const boundary = boundarySnapshot(owner, lineage[index]);
      boundaries.unshift(boundary);
      if (boundary?.policy === 'empty-next-cold-start') {
        start = index;
        reset = true;
        break;
      }
    }
    const relevant = lineage.slice(start);
    const observedCurrent = await owner.readSession(currentSessionId);
    if (!observedCurrent) fail();
    const currentIdentity = identitySnapshot(observedCurrent, currentSessionId);
    if (!sameScope(currentIdentity, scope)) fail();
    const previous = await Promise.all(
      relevant.slice(0, -1).map(async (row) => {
        const observed = await owner.readSession(row.sessionId);
        if (!observed) fail();
        return identitySnapshot(observed, row.sessionId);
      }),
    );
    const identities = [...previous, currentIdentity];
    if (!(await owner.isAuthorityCurrent())) fail();
    let nativeStart = identities.length - 1;
    let cutReason: NativeMemoryContinuityBinding['cutReason'] = reset
      ? 'empty-context'
      : 'start';
    for (let index = identities.length - 2; index >= 0; index--) {
      const identity = identities[index];
      if (!sameScope(identity, scope)) {
        cutReason = 'identity-change';
        break;
      }
      if (identity.persistSession === false || identity.status === 'dead') {
        cutReason = 'native-history-unavailable';
        break;
      }
      nativeStart = index;
    }
    const latestBoundaries = relevant.map((row) =>
      boundarySnapshot(owner, row),
    );
    if (JSON.stringify(boundaries) !== JSON.stringify(latestBoundaries)) fail();
    const latest = owner
      .conversationSessions(conversationId)
      .map(lineageSnapshot);
    const latestCurrent = owner.conversationForSession(currentSessionId);
    if (
      !latestCurrent ||
      JSON.stringify(lineageSnapshot(latestCurrent)) !== JSON.stringify(last) ||
      JSON.stringify(lineage) !== JSON.stringify(latest)
    )
      fail();
    return {
      conversationId,
      sessionIds: relevant.slice(nativeStart).map((row) => row.sessionId),
      canonicalPrefixSessionIds: relevant
        .slice(0, nativeStart)
        .map((row) => row.sessionId),
      cutReason,
      fingerprint: JSON.stringify({
        lineage,
        identities,
        boundaries,
        cutReason,
      }),
    };
  };
  try {
    const snapshot = await observe();
    if ((await observe()).fingerprint !== snapshot.fingerprint) fail();
    const binding = Object.freeze({
      conversationId: snapshot.conversationId,
      currentSessionId,
      scope,
      sessionIds: Object.freeze(snapshot.sessionIds),
      canonicalPrefixSessionIds: Object.freeze(
        snapshot.canonicalPrefixSessionIds,
      ),
      cutReason: snapshot.cutReason,
      async isCurrent() {
        try {
          return (await observe()).fingerprint === snapshot.fingerprint;
        } catch {
          return false;
        }
      },
    }) as NativeMemoryContinuityBinding;
    issuedBindings.add(binding);
    return binding;
  } catch {
    return fail();
  }
}
