/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsentMessages } from '../components/chat/UnsentMessages';
import { activeChatsStore } from '../contexts/active-chats-store';

const sessionId = 'unsent-session';

// archive#3706: this surface is the only durable place a refused follow-up's
// text still exists — every affordance is about getting the text back OUT.
describe('UnsentMessages', () => {
  beforeEach(() => {
    activeChatsStore.initChat(sessionId, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'New chat',
    });
    activeChatsStore.updateChat(sessionId, {
      unsentMessages: [
        {
          id: 'row-1',
          content: 'the refused follow-up',
          reason: 'This chat had already ended when Station tried to send it.',
          at: 111,
        },
        {
          id: 'row-2',
          content: 'a second one',
          reason: 'Refused twice.',
          // Same millisecond as row-1 on purpose: identity is `id`, and a
          // dismiss must not take its same-timestamp neighbour with it
          // (archive#3706).
          at: 111,
        },
      ],
    });
  });

  afterEach(() => {
    activeChatsStore.removeChat(sessionId);
    vi.restoreAllMocks();
  });

  function currentRecords() {
    return activeChatsStore.getSnapshot()[sessionId]?.unsentMessages;
  }

  it('renders each record with its text and its reason', () => {
    render(
      <UnsentMessages
        sessionId={sessionId}
        messages={currentRecords() ?? []}
      />,
    );
    expect(screen.getByText('the refused follow-up')).toBeTruthy();
    expect(
      screen.getByText(
        'This chat had already ended when Station tried to send it.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('a second one')).toBeTruthy();
    // No resend affordance exists: the refusal was permanent for this
    // conversation, and a Retry would re-offer the exact send that was
    // refused.
    expect(screen.queryByRole('button', { name: /retry|resend/i })).toBeNull();
  });

  it('dismiss removes exactly that record from the store', () => {
    render(
      <UnsentMessages
        sessionId={sessionId}
        messages={currentRecords() ?? []}
      />,
    );
    const dismissButtons = screen.getAllByRole('button', {
      name: 'Dismiss unsent message',
    });
    fireEvent.click(dismissButtons[0]);

    expect(currentRecords()?.map((record) => record.id)).toEqual(['row-2']);
  });

  it('copy writes the record text to the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <UnsentMessages
        sessionId={sessionId}
        messages={currentRecords() ?? []}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    await screen.findByRole('button', { name: 'Copied' });

    expect(writeText).toHaveBeenCalledWith('the refused follow-up');
    // Copying must not consume the record — the row stays until Dismiss.
    expect(currentRecords()).toHaveLength(2);
  });

  it('a refused clipboard write does not claim Copied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <UnsentMessages
        sessionId={sessionId}
        messages={currentRecords() ?? []}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    // Give the rejected promise a tick to settle.
    await Promise.resolve();

    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    // The text itself is still on screen, so nothing is lost.
    expect(screen.getByText('the refused follow-up')).toBeTruthy();
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(
      <UnsentMessages sessionId={sessionId} messages={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
