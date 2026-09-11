export type ExtensionNotificationConsumer =
  | 'acp.commands.available'
  | 'acp.turn-error-cause'
  | 'acp.host-chrome'
  | 'ui.kiro.oauth-request'
  | 'ui.kiro.compaction-status'
  | 'ui.kiro.clear-status'
  | 'ui.claude.thinking-tokens'
  | 'ui.claude.session-status'
  | 'ui.claude.task-registry'
  | 'ui.claude.task-settled'
  | 'ui.engine.mcp-status';

export type ExtensionHandshakeVariant =
  | 'kiro-v2'
  | 'kiro-v3'
  | 'claude-adapter'
  | 'xai-acp';

/** Evidence tags: each names the issue whose live runtime observation backs the tuple(s) it is attached to. */
export type ExtensionNotificationEvidence =
  | 'station#1815-runtime-observation'
  | 'station#4084-runtime-observation'
  | 'station#1935-runtime-observation';

export interface ExtensionNotificationBinding {
  readonly namespace: string;
  readonly type: string;
  readonly consumer: ExtensionNotificationConsumer;
  readonly observedAgainst: readonly ExtensionHandshakeVariant[];
  readonly evidence: ExtensionNotificationEvidence;
}

/**
 * Exact evidence-backed application semantics for opaque extension events.
 * Unknown tuples remain opaque/no-op; namespace similarity is never authority.
 */
const DECLARED_EXTENSION_NOTIFICATION_BINDINGS = [
  {
    namespace: '_kiro.dev',
    type: 'commands/available',
    consumer: 'acp.commands.available',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: '_kiro.dev',
    type: 'mcp/oauth_request',
    consumer: 'ui.kiro.oauth-request',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: '_kiro.dev',
    type: 'compaction/status',
    consumer: 'ui.kiro.compaction-status',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: '_kiro.dev',
    type: 'clear/status',
    consumer: 'ui.kiro.clear-status',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    // station#4084 (review fix round F1): the live #1860 verification run
    // observed this exact tuple carrying a human-readable `message`
    // ("The monthly usage limit has been reached") milliseconds before an
    // otherwise-generic turn failure. Per this registry's own rule —
    // "namespace similarity is never authority" — only this exact,
    // evidenced tuple is bound; an analogous notification from another
    // vendor, or another `_kiro.dev/error/*` type, is NOT matched until it
    // is itself observed and added here with its own evidence.
    namespace: '_kiro.dev',
    type: 'error/rate_limit',
    consumer: 'acp.turn-error-cause',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#4084-runtime-observation',
  },
  {
    namespace: 'claude-code',
    type: 'thinking/tokens',
    consumer: 'ui.claude.thinking-tokens',
    observedAgainst: ['claude-adapter'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: 'claude-code',
    type: 'session/status',
    consumer: 'ui.claude.session-status',
    observedAgainst: ['claude-adapter'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: 'claude-code',
    type: 'task/registry',
    consumer: 'ui.claude.task-registry',
    observedAgainst: ['claude-adapter'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: 'claude-code',
    type: 'task/settled',
    consumer: 'ui.claude.task-settled',
    observedAgainst: ['claude-adapter'],
    evidence: 'station#1815-runtime-observation',
  },
  // station#1935: live stable orchestration.sqlite observation. These
  // tuples reach the dock as extension.notification; they are host/session
  // chrome, not transcript facts. Binding them as host-chrome makes the
  // fold exhaustive without inventing chat semantics from vendor payloads.
  {
    namespace: '_kiro.dev',
    type: 'mcp/server_initialized',
    consumer: 'ui.engine.mcp-status',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_kiro.dev',
    type: 'metadata',
    consumer: 'acp.host-chrome',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_kiro.dev',
    type: 'subagent/list_update',
    consumer: 'acp.host-chrome',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'models/update',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'settings/update',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'sessions/changed',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'announcements/update',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'queue/changed',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'session_notification',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'session/prompt_complete',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'mcp/init_progress',
    consumer: 'ui.engine.mcp-status',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'mcp_initialized',
    consumer: 'ui.engine.mcp-status',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'mcp/servers_updated',
    consumer: 'ui.engine.mcp-status',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
] as const satisfies readonly ExtensionNotificationBinding[];

export const EXTENSION_NOTIFICATION_BINDINGS: readonly ExtensionNotificationBinding[] =
  Object.freeze(
    DECLARED_EXTENSION_NOTIFICATION_BINDINGS.map((binding) =>
      Object.freeze({
        ...binding,
        observedAgainst: Object.freeze([...binding.observedAgainst]),
      }),
    ),
  );

export const EXTENSION_NOTIFICATION_EVIDENCE_GAPS = Object.freeze([
  Object.freeze({
    namespace: '_kiro',
    observedAgainst: 'kiro-v3' as const,
    gap: 'notification spelling has not been observed',
  }),
]);

export function extensionNotificationBinding(
  namespace: string,
  type: string,
): ExtensionNotificationBinding | undefined {
  return EXTENSION_NOTIFICATION_BINDINGS.find(
    (binding) => binding.namespace === namespace && binding.type === type,
  );
}
