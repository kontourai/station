// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ConversationHandoffBoundary } from '../components/chat/ConversationHandoffBoundary';

const handoff = {
  predecessorSessionId: 'session-a',
  sessionId: 'session-b',
  idempotencyKey: 'handoff-key',
  targetAgentId: 'codex',
  targetConnectionId: 'codex-private-id',
  targetModelId: 'gpt-5',
  createdAt: '2026-08-24T12:00:00.000Z',
  carried: [
    'authorizedTranscript',
    'ownerTenantWorkspace',
    'targetAgentModel',
  ] as const,
  reset: [
    'providerNativeCursor',
    'toolState',
    'sessionApprovals',
    'mcpAndEngineConfiguration',
    'activeTurnsAndInterrupts',
    'queuedRequests',
    'sessionLocalGrants',
    'taskWorkflowReferences',
  ] as const,
};

describe('ConversationHandoffBoundary', () => {
  test('uses canonical Agent and Engine display names and renders the server disclosure', () => {
    render(
      <ConversationHandoffBoundary
        handoff={handoff}
        agents={[
          {
            slug: 'codex' as never,
            name: 'Code reviewer',
            engineDisplayName: 'Codex',
            engineId: 'codex' as never,
            execution: { agentConnectionId: 'codex-private-id' as never },
          },
        ]}
      />,
    );

    expect(
      screen.getByText('Continued with Code reviewer (Codex)'),
    ).toBeTruthy();
    expect(screen.queryByText(/codex-private-id/)).toBeNull();
    expect(screen.getByText('What carried and reset')).toBeTruthy();
  });

  test('does not promote a deleted target connection id into an Engine name', () => {
    render(<ConversationHandoffBoundary handoff={handoff} agents={[]} />);

    expect(
      screen.getByText(
        'Continued with deleted Agent “codex” (engine unavailable)',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Recorded engine connection: codex-private-id'),
    ).toBeTruthy();
  });
});
