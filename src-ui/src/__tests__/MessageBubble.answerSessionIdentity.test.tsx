/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../types';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../components/chat/AttachAnswerToTaskButton', () => ({
  ConnectedAnswerActions: ({
    sessionId,
    turnId,
  }: {
    sessionId: string;
    turnId: string;
  }) => (
    <>
      <output data-testid="answer-origin">{`${sessionId}/${turnId}`}</output>
      <output data-testid="basis-origin">{`${sessionId}/${turnId}`}</output>
    </>
  ),
  ConnectedAttachAnswerToTaskButton: ({
    sessionId,
    turnId,
  }: {
    sessionId: string;
    turnId: string;
  }) => <output data-testid="answer-origin">{`${sessionId}/${turnId}`}</output>,
  ConnectedAttachUserInputToTaskButton: ({
    sessionId,
    eventId,
  }: {
    sessionId: string;
    eventId: string;
  }) => <output data-testid="input-origin">{`${sessionId}/${eventId}`}</output>,
}));
vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => ({
  ConnectedAnswerBasisAffordance: ({
    sessionId,
    turnId,
  }: {
    sessionId: string;
    turnId: string;
  }) => <output data-testid="basis-origin">{`${sessionId}/${turnId}`}</output>,
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

function row(message: ChatMessage, conversationId?: string) {
  return (
    <MessageBubble
      msg={message}
      idx={0}
      activeSession={{
        id: 'replacement-session',
        ...(conversationId ? { conversationId } : {}),
        agentSlug: 'station',
        messages: [message],
      }}
      agents={[]}
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={false}
      onCopy={() => {}}
    />
  );
}

describe('MessageBubble answer Session identity', () => {
  test('attaches a historical row using its originating execution Session', async () => {
    render(
      row(
        {
          role: 'assistant',
          content: 'Historical answer',
          sessionId: 'original-session',
          turnId: 'turn-1',
          answerEligible: true,
        },
        'conversation-1',
      ),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'More answer actions' }),
    );
    expect((await screen.findByTestId('answer-origin')).textContent).toBe(
      'original-session/turn-1',
    );
    expect(screen.queryByTestId('basis-origin')).toBeNull();
  });

  test('does not guess the active replacement Session for an untagged historical row', () => {
    render(
      row(
        { role: 'assistant', content: 'Unknown origin', turnId: 'turn-1' },
        'conversation-1',
      ),
    );
    expect(screen.queryByTestId('answer-origin')).toBeNull();
    expect(screen.queryByTestId('basis-origin')).toBeNull();
  });

  test('offers a Task action only for a durable user row with its full source tuple', async () => {
    render(
      row(
        {
          role: 'user',
          content: 'Durable input',
          sessionId: 'original-session',
          turnId: 'turn-1',
          sourceEventId: 'event-1',
        },
        'conversation-1',
      ),
    );
    expect((await screen.findByTestId('input-origin')).textContent).toBe(
      'original-session/event-1',
    );
  });

  test('does not offer a Task action for an optimistic or content-reconciled user row', () => {
    render(
      row({ role: 'user', content: 'Optimistic input', clientId: 'local-1' }),
    );
    expect(screen.queryByTestId('input-origin')).toBeNull();
  });
});
