/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const saveRating = vi.fn();
const deleteRating = vi.fn();
const ratings: unknown[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  useFeedbackRatingsQuery: () => ({ data: ratings }),
  useSaveFeedbackRatingMutation: () => ({ mutateAsync: saveRating }),
  useDeleteFeedbackRatingMutation: () => ({ mutateAsync: deleteRating }),
}));

import { MessageRating } from '../components/chat/message-bubble/MessageRating';
import { captureTroubleshootSeeds } from '../components/troubleshoot/__tests__/captureTroubleshootSeeds';

describe('MessageRating accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveRating.mockResolvedValue(undefined);
    deleteRating.mockResolvedValue(undefined);
  });

  test('labels toggle buttons and reflects rating state after click callbacks', async () => {
    render(
      <MessageRating
        conversationId="conversation-1"
        messageIndex={4}
        messagePreview="Helpful response"
        agentSlug="codex"
      />,
    );

    const good = screen.getByRole('button', {
      name: 'Good response',
    }) as HTMLButtonElement;
    const bad = screen.getByRole('button', {
      name: 'Bad response',
    }) as HTMLButtonElement;
    expect(good.type).toBe('button');
    expect(bad.type).toBe('button');
    expect(good.getAttribute('aria-pressed')).toBe('false');
    expect(bad.getAttribute('aria-pressed')).toBe('false');
    expect(good.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(good);
    expect(good.getAttribute('aria-pressed')).toBe('true');
    expect(bad.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() =>
      expect(saveRating).toHaveBeenCalledWith({
        agentSlug: 'codex',
        conversationId: 'conversation-1',
        messageIndex: 4,
        messagePreview: 'Helpful response',
        rating: 'thumbs_up',
      }),
    );

    fireEvent.click(good);
    expect(good.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() =>
      expect(deleteRating).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        messageIndex: 4,
      }),
    );
  });
});

test('failed reason writes keep the entered feedback visible and do not pretend it was saved', async () => {
  saveRating
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      new Error('Feedback history is full. Delete feedback to continue.'),
    );
  render(
    <MessageRating
      conversationId="conversation-1"
      messageIndex={4}
      messagePreview="Response"
      agentSlug="agent"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bad response' }));
  const input = await screen.findByPlaceholderText('Why? (optional)');
  fireEvent.change(input, { target: { value: 'Keep this reason' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByText('Rating not saved')).toBeTruthy();
  expect(
    (screen.getByPlaceholderText('Why? (optional)') as HTMLInputElement).value,
  ).toBe('Keep this reason');
});

// #4470: thumbs-down can hand the reply to troubleshooting.
describe('This looks like a Station bug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveRating.mockResolvedValue(undefined);
    deleteRating.mockResolvedValue(undefined);
  });

  test('appears only after thumbs-down, records the rating as usual, and hands off with the conversation and turn', async () => {
    window.history.pushState({}, '', '/chat');
    const capture = captureTroubleshootSeeds();
    try {
      render(
        <MessageRating
          conversationId="conversation-rated"
          messageIndex={2}
          messagePreview="A reply"
          agentSlug="codex"
          sessionId="session-rated"
          turnId="turn-rated"
        />,
      );
      expect(
        screen.queryByRole('button', { name: 'This looks like a Station bug' }),
      ).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Bad response' }));
      await waitFor(() => expect(saveRating).toHaveBeenCalledTimes(1));
      expect(saveRating).toHaveBeenCalledWith({
        agentSlug: 'codex',
        conversationId: 'conversation-rated',
        messageIndex: 2,
        messagePreview: 'A reply',
        rating: 'thumbs_down',
        expectedSessionId: 'session-rated',
        expectedTurnId: 'turn-rated',
      });

      fireEvent.click(
        screen.getByRole('button', { name: 'This looks like a Station bug' }),
      );
      expect(capture.seeds).toEqual([
        {
          route: '/chat',
          errorSummary:
            'reply-marked-station-bug: The person marked this reply as a Station bug.',
          conversationId: 'conversation-rated',
          turnId: 'turn-rated',
        },
      ]);
      // The bug report writes nothing into the rating: no reason, no re-save.
      expect(saveRating).toHaveBeenCalledTimes(1);
      expect(deleteRating).not.toHaveBeenCalled();
    } finally {
      capture.stop();
      window.history.pushState({}, '', '/');
    }
  });
});
