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
  /** Must apply the captured SessionReadScope, including to every predecessor. */
  readSession(sessionId: string): Promise<NativeMemorySessionIdentity | null>;
  /** Existing authority/turn owner; this module creates no authority of its own. */
  isAuthorityCurrent(): boolean | Promise<boolean>;
}

declare const nativeMemoryBindingBrand: unique symbol;
export interface NativeMemoryContinuityBinding {
  readonly [nativeMemoryBindingBrand]: true;
  readonly conversationId: string;
  readonly currentSessionId: string;
  readonly scope: Readonly<NativeMemoryScope>;
  /** Existing native memory conversation IDs, oldest first, including current once. */
  readonly sessionIds: readonly string[];
  readonly cutReason: 'start' | 'empty-context' | 'identity-change';
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
  const optional = ['connectionId', 'userId', 'tenantId', 'projectId'] as const;
  for (const key of optional)
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

/** Resolve only immutable lineage facts and authorized identities. No history is copied or written. */
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
    const sessionIds: string[] = [];
    const identities: NativeMemorySessionIdentity[] = [];
    const boundaries: unknown[] = [];
    const visitedBoundaryRows: Readonly<ConversationSessionLineage>[] = [];
    let cutReason: NativeMemoryContinuityBinding['cutReason'] = 'start';
    for (let index = lineage.length - 1; index >= 0; index--) {
      const row = lineage[index];
      const observed = await owner.readSession(row.sessionId);
      if (
        !observed ||
        observed.sessionId !== row.sessionId ||
        !(await owner.isAuthorityCurrent())
      )
        fail();
      const identity = {
        sessionId: observed.sessionId,
        provider: observed.provider,
        connectionId: observed.connectionId,
        agentId: observed.agentId,
        userId: observed.userId,
        tenantId: observed.tenantId,
        projectId: observed.projectId,
      };
      identities.push(identity);
      if (!sameScope(identity, scope)) {
        if (index === lineage.length - 1) fail();
        cutReason = 'identity-change';
        break;
      }
      sessionIds.push(row.sessionId);
      visitedBoundaryRows.push(row);
      const boundary = owner.contextBoundaryForSuccessor(row.sessionId);
      if (boundary) {
        if (
          boundary.conversationId !== conversationId ||
          boundary.successorSessionId !== row.sessionId ||
          boundary.predecessorSessionId !== row.predecessorSessionId ||
          !identifier(boundary.boundaryId) ||
          !['reserved', 'claimed', 'consumed', 'failed'].includes(
            boundary.status,
          ) ||
          !['continue-from-history', 'empty-next-cold-start'].includes(
            boundary.policy,
          )
        )
          fail();
        // Claim completion does not change the history decision. Cancellation,
        // indeterminate outcome, a replacement marker or changed policy does.
        boundaries.push({
          boundaryId: boundary.boundaryId,
          successorSessionId: boundary.successorSessionId,
          predecessorSessionId: boundary.predecessorSessionId,
          policy: boundary.policy,
        });
        if (boundary.policy === 'empty-next-cold-start') {
          cutReason = 'empty-context';
          break;
        }
      }
    }
    if (!(await owner.isAuthorityCurrent())) fail();
    const latestBoundaries = visitedBoundaryRows.flatMap((row) => {
      const boundary = owner.contextBoundaryForSuccessor(row.sessionId);
      if (!boundary) return [];
      if (
        !['reserved', 'claimed', 'consumed', 'failed'].includes(boundary.status)
      )
        fail();
      return [
        {
          boundaryId: boundary.boundaryId,
          successorSessionId: boundary.successorSessionId,
          predecessorSessionId: boundary.predecessorSessionId,
          policy: boundary.policy,
        },
      ];
    });
    if (JSON.stringify(boundaries) !== JSON.stringify(latestBoundaries)) fail();
    const latest = owner
      .conversationSessions(conversationId)
      .map(lineageSnapshot);
    if (JSON.stringify(lineage) !== JSON.stringify(latest)) fail();
    return {
      conversationId,
      sessionIds: sessionIds.reverse(),
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
