// @vitest-environment jsdom

import {
  CONVERSATION_HANDOFF_CARRIED_FIELDS,
  CONVERSATION_HANDOFF_RESET_FIELDS,
} from '@kontourai/station-contracts/orchestration';
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
  test('a return to an earlier engine says it picked up its own conversation, and lists only what was reset', () => {
    render(
      <ConversationHandoffBoundary
        // The record a return writes (conversation-handoff-module.ts
        // `describe`): every carried field plus the native session, and
        // every reset field but the native cursor.
        handoff={{
          ...handoff,
          carried: [...CONVERSATION_HANDOFF_CARRIED_FIELDS, 'nativeSession'],
          reset: CONVERSATION_HANDOFF_RESET_FIELDS.filter(
            (field) => field !== 'providerNativeCursor',
          ),
          nativeReturn: { sourceSessionId: 'session-0' },
        }}
        agents={[]}
      />,
    );
    expect(
      screen.getByText(
        'deleted Agent “codex” picked up its earlier conversation and read what it missed. Approvals, tool servers and queued messages start fresh.',
      ),
    ).toBeTruthy();
  });

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

    // Plain text in reading order, named "agent · engine" (glossary), with
    // no label that would read it twice.
    expect(
      screen.getByText('Switched to Code reviewer · Codex · GPT 5'),
    ).toBeTruthy();
    expect(screen.queryByRole('region')).toBeNull();
    expect(
      screen.getByText(
        'Code reviewer read up to about 8K tokens of recent messages. Approvals, tool servers and queued messages start fresh.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/codex-private-id/)).toBeNull();
    expect(screen.getByText('What carried and reset')).toBeTruthy();
  });

  test('does not promote a deleted target connection id into an Engine name', () => {
    render(<ConversationHandoffBoundary handoff={handoff} agents={[]} />);

    expect(
      screen.getByText(
        'Switched to deleted Agent “codex” · engine unavailable · GPT 5',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Recorded engine connection: codex-private-id'),
    ).toBeTruthy();
  });
});
