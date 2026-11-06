/**
 * @vitest-environment jsdom
 *
 * #4512: a continuation Station sent after a restart cut unattended work
 * off is sent as the Session's owner but written by Station: the transcript
 * shows it as Station's, labelled "Continued after restart". The person's
 * own Continue (same key, their own origin) stays theirs. The row comes
 * through the real projection, from the event shape the server writes.
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
  'Station restarted while you were working and your last turn was cut off.';

function startEvent(origin: 'internal' | 'operator') {
  return {
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-11-04T00:00:00.000Z',
    eventId: 'e1',
    method: 'turn.started',
    turnId: 'turn-1',
    prompt: PROMPT,
    clientTurnId: 'continue-interrupted:turn-boundary:3f1c',
    clientOrigin: {
      version: 1,
      actor: { kind: origin },
      reported: { surface: 'unknown' },
    },
  } as unknown as CanonicalRuntimeEvent;
}

function userRow(origin: 'internal' | 'operator'): ChatMessage {
  const row = projectRuntimeEventsToMessages([startEvent(origin)]).find(
    (message) => message.role === 'user',
  )!;
  // The transcript's mapping of this flag (`useActiveChatTranscript`, whose
  // own test pins it).
  return {
    role: 'user',
    content: PROMPT,
    turnId: 'turn-1',
    ...(row.metadata?.stationRestartContinuation
      ? { stationRestartContinuation: true }
      : {}),
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

describe('a restart continuation in the transcript', () => {
  test('reads as Station’s, labelled Continued after restart', () => {
    const view = renderRow(userRow('internal'));
    expect(screen.getByText('Continued after restart')).toBeTruthy();
    expect(screen.queryByText('Person')).toBeNull();
    expect(
      view.container.querySelector('.message--station-check-back'),
    ).not.toBeNull();
  });

  test('the person’s own Continue is still theirs', () => {
    const view = renderRow(userRow('operator'));
    expect(screen.queryByText('Continued after restart')).toBeNull();
    expect(screen.getByText('Person')).toBeTruthy();
    expect(
      view.container.querySelector('.message--station-check-back'),
    ).toBeNull();
  });

  test('the live path marks the row from the same event', async () => {
    const { handleTurnStartedEvent } = await import(
      '../hooks/orchestration/turnHandlers'
    );
    const updateChat = vi.fn();
    handleTurnStartedEvent(startEvent('internal') as never, {
      getChatForExecutionSession: () => ({ messages: [] }) as never,
      updateChat,
    });
    const messages = updateChat.mock.calls[0]?.[1]?.messages as ChatMessage[];
    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      stationRestartContinuation: true,
    });
  });
});
