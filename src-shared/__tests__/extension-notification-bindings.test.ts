import { describe, expect, test } from 'vitest';
import {
  EXTENSION_NOTIFICATION_BINDINGS,
  extensionNotificationBinding,
  takeUnboundExtensionNotice,
} from '../extension-notification-bindings.js';

describe('extension notification bindings', () => {
  test('pins the exact evidenced functional consumer set', () => {
    expect(Object.isFrozen(EXTENSION_NOTIFICATION_BINDINGS)).toBe(true);
    expect(
      EXTENSION_NOTIFICATION_BINDINGS.every(
        (binding) =>
          Object.isFrozen(binding) && Object.isFrozen(binding.observedAgainst),
      ),
    ).toBe(true);
    // The exact (namespace, type, consumer) allowlist (ADR 0013), plus its
    // provenance. archive#4084 review fix round: project `evidence` and
    // `observedAgainst` too, so a binding attributed to the wrong runtime
    // observation (e.g. error/rate_limit credited to #1815 instead of #4084)
    // fails here instead of hiding behind the projection.
    expect(
      EXTENSION_NOTIFICATION_BINDINGS.map(
        ({ namespace, type, consumer, observedAgainst, evidence }) => ({
          namespace,
          type,
          consumer,
          observedAgainst,
          evidence,
        }),
      ),
    ).toEqual([
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
        namespace: '_kiro.dev',
        type: 'error/rate_limit',
        consumer: 'acp.turn-error-cause',
        observedAgainst: ['kiro-v2'],
        evidence: 'station#4084-runtime-observation',
      },
      {
        namespace: 'claude-code',
        type: 'api/retry',
        consumer: 'ui.claude.api-retry',
        observedAgainst: ['claude-adapter'],
        evidence: 'claude-sdk-api-retry-contract',
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
      // station#3415: derived from the transcript projection's marker table.
      {
        namespace: 'codex-rollout',
        type: 'context-compacted',
        consumer: 'transcript.marker',
        observedAgainst: ['codex-rollout-session-source'],
        evidence: 'station-session-source-emitter',
      },
      {
        namespace: 'grok-session',
        type: 'context-compacted',
        consumer: 'transcript.marker',
        observedAgainst: ['grok-session-source'],
        evidence: 'station-session-source-emitter',
      },
      {
        namespace: 'grok-session',
        type: 'conversation-rewound',
        consumer: 'transcript.marker',
        observedAgainst: ['grok-session-source'],
        evidence: 'station-session-source-emitter',
      },
    ]);
  });

  test('keeps the unevidenced v3 spelling as an exact no-op', () => {
    expect(
      extensionNotificationBinding('_kiro', 'mcp/oauth_request'),
    ).toBeUndefined();
    expect(
      extensionNotificationBinding('_kiro.dev', 'unknown'),
    ).toBeUndefined();
  });

  test('takeUnboundExtensionNotice fires once per provider-tuple', () => {
    // A tuple no other test in this module instance takes, so the
    // process-lifetime first-seen set starts without it.
    const type = 'bindings-test/fires-once';
    expect(takeUnboundExtensionNotice('acp', '_x.ai', type)).toBe(true);
    expect(takeUnboundExtensionNotice('acp', '_x.ai', type)).toBe(false);
    expect(takeUnboundExtensionNotice('claude', '_x.ai', type)).toBe(true);
  });
});
