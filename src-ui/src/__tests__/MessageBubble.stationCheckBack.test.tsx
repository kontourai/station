/**
 * @vitest-environment jsdom
 *
 * A check-back Station sent into the chat is sent as the person but written
 * by nobody: the transcript shows it as Station's, never as the person's
 * own message. The row comes through the real projection and the
 * transcript's own field mapping, from the event shape the server writes.
 */

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../types';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span>Person</span>,
}));
vi.mock('../components/icons/AgentIcon', () => ({
  AgentIcon: () => <span>Agent</span>,
}));
vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => ({
  ConnectedAnswerBasisAffordance: () => null,
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

const PROMPT =
  '[Station] The check-back you scheduled is due. This message is from Station, not the person. Your note:\n\ncheck the deploy';

function userRow(origin: 'internal' | 'operator'): ChatMessage {
  const event = {
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-10-20T00:00:00.000Z',
    eventId: 'e1',
    method: 'turn.started',
    turnId: 'turn-1',
    prompt: PROMPT,
    clientTurnId: 'wake-up:0f8fad5b-d9cb-469f-a165-70867728950e',
    clientOrigin: {
      version: 1,
      actor: { kind: origin },
      reported: { surface: 'unknown' },
    },
  } as unknown as CanonicalRuntimeEvent;
  const row = projectRuntimeEventsToMessages([event]).find(
    (message) => message.role === 'user',
  )!;
  // The transcript's mapping of this flag (`useActiveChatTranscript`).
  return {
    role: 'user',
    content: PROMPT,
    turnId: 'turn-1',
    ...(row.metadata?.stationCheckBack ? { stationCheckBack: true } : {}),
  };
}

function renderRow(msg: ChatMessage) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageBubble
        msg={msg}
        idx={0}
        activeSession={{ id: 'thread-1', agentSlug: 'agent', messageCount: 2 }}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        anchorKey="row-1"
      />
    </QueryClientProvider>,
  );
}

describe('a check-back in the transcript', () => {
  test('reads as Station’s, without the person’s avatar', () => {
    const view = renderRow(userRow('internal'));
    expect(screen.getByText('Scheduled check-back')).toBeTruthy();
    expect(screen.queryByText('Person')).toBeNull();
    expect(
      view.container.querySelector('.message--station-check-back'),
    ).not.toBeNull();
  });

  test('a person’s own message with the same text is still theirs', () => {
    const view = renderRow(userRow('operator'));
    expect(screen.queryByText('Scheduled check-back')).toBeNull();
    expect(screen.getByText('Person')).toBeTruthy();
    expect(
      view.container.querySelector('.message--station-check-back'),
    ).toBeNull();
  });

  test('the live path marks the row it restores from the same event', async () => {
    const { handleTurnStartedEvent } = await import(
      '../hooks/orchestration/turnHandlers'
    );
    const updateChat = vi.fn();
    handleTurnStartedEvent(
      {
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: '2026-10-20T00:00:00.000Z',
        eventId: 'e1',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: PROMPT,
        clientTurnId: 'wake-up:0f8fad5b-d9cb-469f-a165-70867728950e',
        clientOrigin: {
          version: 1,
          actor: { kind: 'internal' },
          reported: { surface: 'unknown' },
        },
      } as never,
      {
        getChatForExecutionSession: () => ({ messages: [] }) as never,
        updateChat,
      },
    );
    const messages = updateChat.mock.calls[0]?.[1]?.messages as ChatMessage[];
    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      stationCheckBack: true,
    });
  });
});
