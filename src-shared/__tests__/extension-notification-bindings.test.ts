import { describe, expect, test } from 'vitest';
import {
  _resetUnboundExtensionNotices,
  EXTENSION_NOTIFICATION_BINDINGS,
  EXTENSION_NOTIFICATION_PROMOTIONS,
  extensionNotificationBinding,
  isBoundExtensionNotification,
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
    // The exact (namespace, type, consumer) allowlist (ADR 0013): binding an
    // extra tuple widens which vendor payloads reach a consumer, so any
    // addition, removal, or rerouting must fail here. `evidence` and
    // `observedAgainst` are review labels nothing reads, so they stay out.
    expect(
      EXTENSION_NOTIFICATION_BINDINGS.map(({ namespace, type, consumer }) => ({
        namespace,
        type,
        consumer,
      })),
    ).toEqual([
      {
        namespace: '_kiro.dev',
        type: 'commands/available',
        consumer: 'acp.commands.available',
      },
      {
        namespace: '_kiro.dev',
        type: 'mcp/oauth_request',
        consumer: 'ui.kiro.oauth-request',
      },
      {
        namespace: '_kiro.dev',
        type: 'compaction/status',
        consumer: 'ui.kiro.compaction-status',
      },
      {
        namespace: '_kiro.dev',
        type: 'clear/status',
        consumer: 'ui.kiro.clear-status',
      },
      {
        namespace: '_kiro.dev',
        type: 'error/rate_limit',
        consumer: 'acp.turn-error-cause',
      },
      {
        namespace: 'claude-code',
        type: 'thinking/tokens',
        consumer: 'ui.claude.thinking-tokens',
      },
      {
        namespace: 'claude-code',
        type: 'session/status',
        consumer: 'ui.claude.session-status',
      },
      {
        namespace: 'claude-code',
        type: 'task/registry',
        consumer: 'ui.claude.task-registry',
      },
      {
        namespace: 'claude-code',
        type: 'task/settled',
        consumer: 'ui.claude.task-settled',
      },
      {
        namespace: '_kiro.dev',
        type: 'mcp/server_initialized',
        consumer: 'ui.engine.mcp-status',
      },
      {
        namespace: '_kiro.dev',
        type: 'metadata',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_kiro.dev',
        type: 'subagent/list_update',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_x.ai',
        type: 'models/update',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_x.ai',
        type: 'settings/update',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_x.ai',
        type: 'sessions/changed',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_x.ai',
        type: 'announcements/update',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_x.ai',
        type: 'queue/changed',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_x.ai',
        type: 'session_notification',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_x.ai',
        type: 'session/prompt_complete',
        consumer: 'acp.host-chrome',
      },
      {
        namespace: '_x.ai',
        type: 'mcp/init_progress',
        consumer: 'ui.engine.mcp-status',
      },
      {
        namespace: '_x.ai',
        type: 'mcp_initialized',
        consumer: 'ui.engine.mcp-status',
      },
      {
        namespace: '_x.ai',
        type: 'mcp/servers_updated',
        consumer: 'ui.engine.mcp-status',
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

  test('every promotion stays bound until the adapter emits the Station event', () => {
    for (const item of EXTENSION_NOTIFICATION_PROMOTIONS) {
      expect(
        isBoundExtensionNotification(item.namespace, item.type),
        `${item.namespace}/${item.type} must stay bound until resolved`,
      ).toBe(true);
    }
  });

  test('Grok queue/changed promotes to Station follow-up queue, not steer', () => {
    const item = EXTENSION_NOTIFICATION_PROMOTIONS.find(
      (promotion) =>
        promotion.namespace === '_x.ai' && promotion.type === 'queue/changed',
    );
    expect(item?.stationEvent).toBe('queuedMessages');
  });

  test('takeUnboundExtensionNotice fires once per provider-tuple', () => {
    _resetUnboundExtensionNotices();
    expect(takeUnboundExtensionNotice('acp', '_x.ai', 'never/seen')).toBe(true);
    expect(takeUnboundExtensionNotice('acp', '_x.ai', 'never/seen')).toBe(
      false,
    );
    expect(takeUnboundExtensionNotice('claude', '_x.ai', 'never/seen')).toBe(
      true,
    );
    _resetUnboundExtensionNotices();
  });
});
