/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MessageBubble } from '../components/chat/MessageBubble';

vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: ({
    conversationId,
    agentSlug,
  }: {
    conversationId: string;
    agentSlug: string;
  }) => (
    <span data-testid="rating-identity">{`${conversationId}:${agentSlug}`}</span>
  ),
}));
vi.mock('../components/icons/AgentIcon', () => ({
  AgentIcon: ({ agent }: { agent: { slug?: string; name: string } }) => (
    <span data-testid="agent-icon">{`${agent.slug ?? 'none'}:${agent.name}`}</span>
  ),
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span>User</span>,
}));
vi.mock('../components/chat/ShareAnswerButton', () => ({
  ShareAnswerButton: () => null,
}));

const activeSession = {
  id: 'claude-session',
  conversationId: 'durable-conversation',
  agentSlug: 'claude',
  agentName: 'Current Claude Agent',
  messages: [],
};

function row(agentSlug: string | undefined, content: string) {
  return {
    role: 'assistant' as const,
    content,
    sessionId: `${agentSlug}-session`,
    ...(agentSlug ? { agentSlug: agentSlug as never } : {}),
  };
}

describe('MessageBubble session-lineage identity (station#4240)', () => {
  test('offers a keyboard-operable fork only for a completed assistant turn', () => {
    const onForkFromTurn = vi.fn();
    const message = {
      ...row('claude', 'Completed answer'),
      turnId: 'turn-complete',
      answerEligible: true,
    };
    render(
      <MessageBubble
        msg={message}
        idx={0}
        activeSession={{ ...activeSession, messages: [message] } as never}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        onForkFromTurn={onForkFromTurn}
      />,
    );

    const action = screen.getByRole('button', { name: 'Fork from here' });
    expect(action.className).toContain('message__fork-btn');
    fireEvent.click(action);
    expect(onForkFromTurn).toHaveBeenCalledWith({
      turnId: 'turn-complete',
      agentSlug: 'claude',
      sessionId: 'claude-session',
      model: undefined,
      provider: undefined,
    });
  });

  test('fork carries the historical row identity across a later handoff/model switch', () => {
    const onForkFromTurn = vi.fn();
    const message = {
      ...row('codex', 'Historical Codex answer'),
      turnId: 'turn-historical',
      answerEligible: true,
      model: 'unsafe-current-fallback',
      provenance: {
        envelopeVersion: 1,
        sessionId: 'codex-historical-session',
        turnId: 'turn-historical',
        outcome: 'completed',
        observedAt: '2026-08-01T00:00:00.000Z',
        engine: {
          state: 'observed',
          value: { provider: 'codex' },
          observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
        },
        requestedModel: {
          state: 'observed',
          value: 'gpt-5-codex',
          observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
        },
        reportedModel: {
          state: 'observed',
          value: 'gpt-5-codex-reported',
          observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
        },
        tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
        usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
        routingReceipt: {
          state: 'unavailable',
          reason: 'not-captured-by-station',
        },
        sources: {
          state: 'unavailable',
          reason: 'not-captured-by-station',
        },
        trustReport: {
          state: 'unavailable',
          reason: 'not-captured-by-station',
        },
      },
    };
    render(
      <MessageBubble
        msg={message}
        idx={0}
        activeSession={
          {
            ...activeSession,
            agentSlug: 'claude',
            model: 'claude-new-default',
            messages: [message],
          } as never
        }
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        onForkFromTurn={onForkFromTurn}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fork from here' }));
    expect(onForkFromTurn).toHaveBeenCalledWith({
      turnId: 'turn-historical',
      agentSlug: 'codex',
      sessionId: 'codex-historical-session',
      provider: 'codex',
      model: 'gpt-5-codex-reported',
    });
  });

  test('omits fork for an incomplete assistant turn', () => {
    const message = {
      ...row('claude', 'Still streaming'),
      turnId: 'turn-open',
      answerEligible: false,
    };
    render(
      <MessageBubble
        msg={message}
        idx={0}
        activeSession={{ ...activeSession, messages: [message] } as never}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        onForkFromTurn={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Fork from here' })).toBeNull();
  });

  test('renders a historical Codex answer from its own Agent, never the current Claude Agent', () => {
    const message = {
      ...row('codex', 'Codex answer'),
      agentDisplayName: 'Historical Codex Agent',
      agentIcon: 'terminal',
    };
    render(
      <MessageBubble
        msg={message}
        idx={0}
        activeSession={{ ...activeSession, messages: [message] } as never}
        agents={
          [
            { slug: 'codex', name: 'Renamed Codex Agent', icon: 'sparkles' },
            { slug: 'claude', name: 'Current Claude Agent', icon: 'sparkles' },
          ] as never
        }
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
      />,
    );

    expect(screen.getByTestId('agent-icon').textContent).toBe(
      'codex:Historical Codex Agent',
    );
    expect(screen.getByText('Historical Codex Agent')).toBeTruthy();
    expect(screen.queryByText('Renamed Codex Agent')).toBeNull();
    expect(screen.queryByText('Current Claude Agent')).toBeNull();
    expect(screen.getByTestId('rating-identity').textContent).toBe(
      'durable-conversation:codex',
    );
  });

  test('renders a deleted historical Agent honestly without borrowing the current Agent icon', () => {
    const message = row('deleted-codex', 'Restored answer');
    render(
      <MessageBubble
        msg={message}
        idx={0}
        activeSession={{ ...activeSession, messages: [message] } as never}
        agents={[{ slug: 'claude', name: 'Current Claude Agent' }] as never}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
      />,
    );

    expect(screen.getByTestId('agent-icon').textContent).toBe(
      'deleted-codex:Deleted Agent “deleted-codex”',
    );
    expect(screen.getByText('Deleted Agent “deleted-codex”')).toBeTruthy();
    expect(screen.queryByText('Current Claude Agent')).toBeNull();
  });

  test('omits historical feedback when the producing Session Agent is unresolved', () => {
    const message = row(undefined, 'Unattributed restored answer');
    render(
      <MessageBubble
        msg={message}
        idx={0}
        activeSession={{ ...activeSession, messages: [message] } as never}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
      />,
    );
    expect(screen.queryByTestId('rating-identity')).toBeNull();
  });
});
