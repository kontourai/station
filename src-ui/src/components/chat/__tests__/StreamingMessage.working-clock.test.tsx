/** @vitest-environment jsdom */

/**
 * station#2530 review 4: the working clock (`.streaming-activity`, role
 * "status") must keep showing once answer text has started streaming while
 * the turn is still open — a long answer with tool calls interleaved is
 * exactly when a user wants to see the clock keep counting — and must NOT
 * show once there is no open turn and nothing else (a status label, an
 * explicit elapsed reading, or an unanswered/no-progress state) justifies it.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { ChatContentPart } from '../../../contexts/active-chats-state';
import { StreamingMessageView } from '../StreamingMessage';

afterEach(() => {
  document.body.innerHTML = '';
});

const answerTextPart: ChatContentPart = {
  type: 'text',
  content: 'Here is the answer so far.',
};

const baseProps = {
  sessionId: 'chat-1',
  agentIcon: null,
  agentIconStyle: {},
  fontSize: 14,
  streamingText: '',
  hasContent: true,
  contentRevision: 1,
};

describe('StreamingMessageView working clock', () => {
  test('shows the working clock alongside streamed answer text while the turn is open', () => {
    render(
      <StreamingMessageView
        {...baseProps}
        contentParts={[answerTextPart]}
        conversationActivity={{
          conversationId: 'chat-1',
          asOfSequence: 1,
          openTurn: {
            threadId: 'chat-1',
            turnId: 'turn-1',
            startedAt: '2026-09-24T00:00:00.000Z',
          },
        }}
      />,
    );

    expect(screen.getByText('Here is the answer so far.')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  test('does not show the working clock once there is no open turn, with answer text already present', () => {
    render(
      <StreamingMessageView
        {...baseProps}
        contentParts={[answerTextPart]}
        // No `conversationActivity`, no `turnStartedAt`, no `statusLabel`,
        // no `elapsedMs`, and no `renderToolCall` — nothing left that would
        // justify showing the activity row once the answer has content.
      />,
    );

    expect(screen.getByText('Here is the answer so far.')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
