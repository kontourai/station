/**
 * A paired Station's lifecycle record, in the shape
 * `recordPeerDelegationActivityDispatch` persists and the session read model
 * returns: Station's own provider, a `peer-delegation:` thread, the PEER's
 * conversation id and agent slug, and `delegation.environmentKind: 'peer'`.
 */
export function peerRecordSummary(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'peer-delegation:abc',
    conversationId: 'conv-on-peer',
    provider: 'station-agent',
    status: 'ready',
    controlMode: 'station-owned',
    isLoaded: false,
    isPersisted: true,
    eventCount: 3,
    createdAt: '2026-10-04T12:00:00.000Z',
    updatedAt: '2026-10-04T12:00:00.000Z',
    lifecycleState: 'needs_input',
    answerability: { answerable: true },
    assignedAgentSlug: 'codex',
    delegation: {
      taskId: 'task:peer',
      environmentId: 'environment-peer',
      environmentName: 'Station B',
      environmentKind: 'peer',
      targetKind: 'agent',
      targetId: 'codex',
    },
    ...overrides,
  };
}
