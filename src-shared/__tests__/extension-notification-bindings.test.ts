import { describe, expect, test } from 'vitest';
import {
  EXTENSION_NOTIFICATION_BINDINGS,
  EXTENSION_NOTIFICATION_EVIDENCE_GAPS,
  extensionNotificationBinding,
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
    // L2 (station#4084 review fix round): project `evidence` too — a wrong
    // evidence tag on a tuple (e.g. attributing the new error/rate_limit
    // binding to #1815's runtime observation instead of #4084's) must fail
    // this test, not stay invisible because the projection omitted it.
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
    ]);
  });

  test('keeps the unevidenced v3 spelling as a gap and exact no-op', () => {
    expect(EXTENSION_NOTIFICATION_EVIDENCE_GAPS).toEqual([
      {
        namespace: '_kiro',
        observedAgainst: 'kiro-v3',
        gap: 'notification spelling has not been observed',
      },
    ]);
    expect(
      extensionNotificationBinding('_kiro', 'mcp/oauth_request'),
    ).toBeUndefined();
    expect(
      extensionNotificationBinding('_kiro.dev', 'unknown'),
    ).toBeUndefined();
  });
});
