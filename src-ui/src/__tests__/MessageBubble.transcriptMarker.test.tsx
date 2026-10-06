/**
 * @vitest-environment jsdom
 */

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MessageBubble } from '../components/chat/MessageBubble';
import { conversationPartToContentParts } from '../hooks/orchestration/conversationTranscriptParts';
import type { ChatMessage } from '../types';

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
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });
});
