import { describe, expect, test } from 'vitest';
import { selectWorkflowPlanSession } from '../components/coding-layout/planSession';
import { buildNewTerminalItems } from '../components/coding-layout/utils';
import type { ACPConnectionInfo } from '../hooks/useACPConnections';

const connections: ACPConnectionInfo[] = [
  {
    id: 'kiro',
    name: 'Kiro',
    enabled: true,
    status: 'available',
    modes: ['dev', 'review'],
    sessionId: null,
    mcpServers: [],
    currentModel: null,
  },
  {
    id: 'claude',
    name: 'Claude',
    enabled: true,
    status: 'offline',
    modes: ['planner'],
    sessionId: null,
    mcpServers: [],
    currentModel: null,
  },
];

describe('coding-layout utils', () => {
  test('buildNewTerminalItems includes shell and recent agents first', () => {
    expect(
      buildNewTerminalItems(connections, '', ['kiro-review', 'kiro-dev']),
    ).toEqual([
      {
        key: 'shell',
        type: 'shell',
        label: 'Shell',
        hint: 'Default terminal',
      },
      {
        key: 'recent-kiro-dev',
        type: 'agent',
        label: 'dev',
        hint: 'Kiro · Recent',
        slug: 'kiro-dev',
        connectionId: 'kiro',
        section: 'recent',
      },
      {
        key: 'recent-kiro-review',
        type: 'agent',
        label: 'review',
        hint: 'Kiro · Recent',
        slug: 'kiro-review',
        connectionId: 'kiro',
        section: 'recent',
      },
    ]);
  });

  test('buildNewTerminalItems filters by agent label and hides shell when unmatched', () => {
    expect(buildNewTerminalItems(connections, 'rev', [])).toEqual([
      {
        key: 'kiro-review',
        type: 'agent',
        label: 'review',
        hint: 'Kiro',
        slug: 'kiro-review',
        connectionId: 'kiro',
      },
    ]);
  });

  test('selectWorkflowPlanSession matches active chat by session id before falling back', () => {
    const olderSession = {
      id: 'session-older',
      conversationId: 'conv-older',
      messages: [{ timestamp: 10 }],
    };
    const activeSession = {
      id: 'session-active',
      conversationId: 'conv-active',
      messages: [{ timestamp: 1 }],
    };

    expect(
      selectWorkflowPlanSession(
        [olderSession, activeSession],
        'session-active',
      ),
    ).toEqual(activeSession);
    expect(
      selectWorkflowPlanSession([olderSession, activeSession], 'conv-older'),
    ).toEqual(olderSession);
  });
});
