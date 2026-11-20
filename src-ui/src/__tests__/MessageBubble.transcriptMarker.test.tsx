/**
 * @vitest-environment jsdom
 */

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageBubble } from '../components/chat/MessageBubble';
import {
  conversationMessageToChatMessage,
  conversationPartToContentParts,
} from '../hooks/orchestration/conversationTranscriptParts';
import type { ChatMessage } from '../types';
import { clipboardAbsent, clipboardWrites } from './clipboard-stubs';

vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => ({
  ConnectedAnswerBasisAffordance: () => null,
}));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/AgentIcon', () => ({
  AgentIcon: () => <span>Agent</span>,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span>User</span>,
}));

/**
 * station#3415: the chat dock renders every row through MessageBubble. The
 * marker row comes from the real projection and chat's own part mapping, the
 * same path `useActiveChatTranscript` takes.
 */
describe('MessageBubble transcript marker (station#3415)', () => {
  test('a projected compaction row renders as a marker line, not a speaker bubble', () => {
    const [row] = projectRuntimeEventsToMessages([
      {
        eventId: 'e1',
        provider: 'codex',
        threadId: 'external:codex:s',
        createdAt: '2026-10-05T00:00:00.000Z',
        method: 'extension.notification',
        namespace: 'codex-rollout',
        type: 'context-compacted',
        payload: { source: 'transcript-inference' },
      } as CanonicalRuntimeEvent,
    ]);
    expect(row?.role).toBe('system');
    const msg: ChatMessage = {
      role: row!.role,
      content: '',
      contentParts: row!.parts.flatMap(conversationPartToContentParts),
    };
    const { container } = render(
      <MessageBubble
        msg={msg}
        idx={0}
        activeSession={
          {
            id: 'session-1',
            agentSlug: 'codex',
            agentName: 'Codex',
            messages: [],
            messageCount: 1,
          } as never
        }
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        anchorKey="row-1"
      />,
    );
    const marker = screen
      .getByText('Context compacted')
      .closest('.transcript-marker');
    expect(marker).toBeTruthy();
    expect(marker?.getAttribute('data-chat-message-key')).toBe('row-1');
    expect(container.querySelector('.message-row')).toBeNull();
    expect(screen.queryByText('User')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Copy/ })).toBeNull();
  });
});

describe('paged turn Markdown', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const base = {
    provider: 'claude',
    threadId: 'paged-thread',
    turnId: 'paged-turn',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as const;
  const start = {
    ...base,
    method: 'turn.started',
    eventId: 'turn-start',
    prompt: 'Read the two files',
  } as const;
  const end = {
    ...base,
    method: 'turn.completed',
    eventId: 'turn-end',
    finishReason: 'stop',
  } as const;
  const text = (delta: string, eventId: string): CanonicalRuntimeEvent => ({
    ...base,
    method: 'content.text-delta',
    eventId,
    delta,
  });
  const read = (name: string): CanonicalRuntimeEvent[] => [
    {
      ...base,
      method: 'tool.started',
      eventId: `${name}-started`,
      toolCallId: name,
      toolName: 'Read',
      arguments: { file_path: `${name}.ts` },
    },
    {
      ...base,
      method: 'tool.completed',
      eventId: `${name}-completed`,
      toolCallId: name,
      toolName: 'Read',
      status: 'success',
      output: 'File contents',
    },
  ];
  const earlier = [text('Earlier note', 'earlier-note'), ...read('earlier')];
  const fenced = 'Current note\n\n```text\noriginal code\n```';
  const tail = [text(fenced, 'current-note'), ...read('current')];

  function bubble(
    events: CanonicalRuntimeEvent[],
    { pageHasGap = false, live = false } = {},
  ) {
    const assistant = projectRuntimeEventsToMessages(events, {
      stableIds: true,
      markEndedTurns: true,
      partialTurnStartEventIds: pageHasGap
        ? new Set([start.eventId])
        : undefined,
    }).find((message) => message.role === 'assistant');
    if (!assistant) throw new Error('Expected a projected assistant turn');
    return (
      <MessageBubble
        msg={conversationMessageToChatMessage(assistant)}
        idx={0}
        activeSession={{
          id: base.threadId,
          agentSlug: 'agent',
          messageCount: 1,
          liveTurnId: live ? base.turnId : undefined,
        }}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        anchorKey={assistant.id}
      />
    );
  }

  test('prepending older events preserves focused Markdown controls and copies current code', async () => {
    const writeText = clipboardWrites();
    try {
      const { rerender } = render(
        bubble([start, ...tail, end], { pageHasGap: true }),
      );
      const copy = await screen.findByRole('button', { name: 'Copy' });
      copy.focus();

      rerender(bubble([start, ...earlier, ...tail, end]));
      expect(await screen.findByText('Earlier note')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Copy' })).toBe(copy);
      expect(document.activeElement).toBe(copy);

      rerender(
        bubble([
          start,
          ...earlier,
          text(fenced.replace('original code', 'updated code'), 'current-note'),
          ...read('current'),
          end,
        ]),
      );
      await screen.findByText('updated code');
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith('updated code'),
      );
    } finally {
      clipboardAbsent();
    }
  });

  test.each([false, true])(
    'settling the on-screen turn keeps focus (terminal event already projected: %s)',
    async (alreadyEnded) => {
      const live = alreadyEnded
        ? [start, ...tail, end]
        : [start, text(fenced, 'current-note'), read('current')[0]!];
      const { rerender } = render(bubble(live, { live: true }));
      const copy = await screen.findByRole('button', { name: 'Copy' });
      copy.focus();

      rerender(bubble([start, ...tail, end]));
      expect(await screen.findByRole('button', { name: 'Copy' })).toBe(copy);
      expect(document.activeElement).toBe(copy);
    },
  );
});
