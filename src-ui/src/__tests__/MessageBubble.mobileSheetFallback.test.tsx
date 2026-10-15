/**
 * @vitest-environment jsdom
 *
 * A phone user message's ⋯ sheet must never open empty. Its only item can be
 * the lazily loaded message-actions menu; when that chunk fails to load, the
 * sheet names the failure and offers Retry instead of showing nothing.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => true,
}));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
// The menu's chunk fails to load, as an evicted or offline chunk does.
vi.mock('../components/chat/TurnActionsMenu', () => {
  throw new Error('chunk failed to load');
});

const { MessageBubble } = await import('../components/chat/MessageBubble');

describe('phone user-message sheet when its menu cannot load', () => {
  it('shows the failure with Retry rather than an empty sheet', async () => {
    render(
      <MessageBubble
        msg={{ role: 'user', content: 'Retry this?' }}
        idx={0}
        activeSession={{ id: 'thread-1', agentSlug: 'agent', messageCount: 1 }}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        onNewChatFromMessage={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Your message actions' }),
    );
    const sheet = screen.getByRole('dialog', { name: 'Your message actions' });
    const alert = await within(sheet).findByRole('alert');
    expect(alert.textContent).toContain('Message actions unavailable.');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
