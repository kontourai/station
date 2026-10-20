/**
 * @vitest-environment jsdom
 *
 * A settled assistant row never renders as a header over an empty card. The
 * reasoning-only row comes from the real projection and chat's own part
 * mapping (the path `useActiveChatTranscript` takes), so the test reaches
 * the shape the transcript actually receives.
 */

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { conversationPartToContentParts } from '../hooks/orchestration/conversationTranscriptParts';
import type { ChatMessage } from '../types';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../components/icons/AgentIcon', () => ({
  AgentIcon: () => <span>Agent</span>,
}));
vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => ({
  ConnectedAnswerBasisAffordance: () => <button type="button">Basis</button>,
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

const THOUGHT = 'Weighing the two options before answering.';

function projectedReasoningOnlyRow(): ChatMessage {
  const base = {
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-10-20T00:00:00.000Z',
    turnId: 'turn-1',
  };
  const rows = projectRuntimeEventsToMessages([
    { ...base, eventId: 'e1', method: 'turn.started', prompt: 'hi' },
    {
      ...base,
      eventId: 'e2',
      method: 'content.reasoning-delta',
      delta: THOUGHT,
    },
    { ...base, eventId: 'e3', method: 'turn.completed' },
  ] as CanonicalRuntimeEvent[]);
  const assistant = rows.find((row) => row.role === 'assistant');
  expect(assistant?.parts.map((part) => part.type)).toEqual(['reasoning']);
  return {
    role: 'assistant',
    content: '',
    turnId: 'turn-1',
    contentParts: assistant!.parts.flatMap(conversationPartToContentParts),
  };
}

function renderSettledRow(msg: ChatMessage, showReasoning: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble
        msg={msg}
        // Not the last row: this is a settled row in history.
        idx={0}
        activeSession={{ id: 'thread-1', agentSlug: 'agent', messageCount: 3 }}
        agents={[]}
        chatFontSize={14}
        showReasoning={showReasoning}
        showToolDetails={false}
        onCopy={() => {}}
        anchorKey="row-1"
      />
    </QueryClientProvider>,
  );
}

describe('settled assistant rows with no answer text', () => {
  test('a reasoning-only row keeps a collapsed Reasoning disclosure instead of an empty card', () => {
    const { container } = renderSettledRow(projectedReasoningOnlyRow(), true);
    const disclosure = screen.getByRole('button', {
      name: /^Reasoning · 6 words/,
    });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(THOUGHT)).toBeNull();
    expect(container.querySelector('.message.assistant')).not.toBeNull();

    fireEvent.click(disclosure);
    expect(screen.getByText(THOUGHT)).toBeTruthy();
  });

  test('with reasoning hidden by the reader, the row draws no bubble at all', () => {
    const { container } = renderSettledRow(projectedReasoningOnlyRow(), false);
    expect(container.querySelector('.message-row')).toBeNull();
    expect(screen.queryByText('Agent')).toBeNull();
  });

  test('a row whose only text is whitespace draws no bubble', () => {
    const { container } = renderSettledRow(
      {
        role: 'assistant',
        content: '\n\n',
        contentParts: [{ type: 'text', content: '\n\n' }],
      },
      true,
    );
    expect(container.querySelector('.message-row')).toBeNull();
  });

  test('a row with an answer keeps reasoning out of the bubble (#2211)', () => {
    const row = projectedReasoningOnlyRow();
    renderSettledRow(
      {
        ...row,
        content: 'The answer.',
        contentParts: [
          ...(row.contentParts ?? []),
          { type: 'text', content: 'The answer.' },
        ],
      },
      true,
    );
    expect(screen.getByText('The answer.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reasoning ·/ })).toBeNull();
  });

  test('an empty user row still renders its bubble', () => {
    const { container } = renderSettledRow({ role: 'user', content: '' }, true);
    expect(container.querySelector('.message-row--user')).not.toBeNull();
  });
});
