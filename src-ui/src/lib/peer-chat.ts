export interface PeerChatBinding {
  environmentId: string;
  stationName: string;
  conversationId: string;
  sessionId?: string;
  agentId: string;
  executionAgentId?: string;
  expectedDefinitionFingerprint?: string;
  projectSlug?: string;
  projectName?: string;
  model?: string;
  providerOptions?: Record<string, unknown>;
  pending?: { id: string; text: string; dispatched: boolean };
}

export function peerChatApiBase(
  apiBase: string,
  environmentId: string,
): string {
  return `${apiBase}/api/environments/peers/${encodeURIComponent(environmentId)}/chat-api`;
}

export function readPeerChatBinding(
  value: unknown,
): PeerChatBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    !['environmentId', 'stationName', 'conversationId', 'agentId'].every(
      (key) => typeof v[key] === 'string' && v[key],
    )
  )
    return;
  const optional = (key: string) =>
    typeof v[key] === 'string' ? (v[key] as string) : undefined;
  const pending =
    v.pending && typeof v.pending === 'object'
      ? (v.pending as Record<string, unknown>)
      : undefined;
  return {
    environmentId: v.environmentId as string,
    stationName: v.stationName as string,
    conversationId: v.conversationId as string,
    agentId: v.agentId as string,
    sessionId: optional('sessionId'),
    projectSlug: optional('projectSlug'),
    projectName: optional('projectName'),
    executionAgentId: optional('executionAgentId'),
    expectedDefinitionFingerprint: optional('expectedDefinitionFingerprint'),
    model: optional('model'),
    providerOptions:
      v.providerOptions &&
      typeof v.providerOptions === 'object' &&
      !Array.isArray(v.providerOptions)
        ? (v.providerOptions as Record<string, unknown>)
        : undefined,
    ...(pending &&
    typeof pending.id === 'string' &&
    typeof pending.text === 'string'
      ? {
          pending: {
            id: pending.id,
            text: pending.text,
            dispatched: pending.dispatched !== false,
          },
        }
      : {}),
  };
}
