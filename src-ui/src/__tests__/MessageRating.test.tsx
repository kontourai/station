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
