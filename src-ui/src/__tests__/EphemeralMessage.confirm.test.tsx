/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));

const { EphemeralMessage } = await import(
  '../components/chat/EphemeralMessage'
);

describe('EphemeralMessage action that asks first', () => {
  afterEach(cleanup);

  it('runs only after the shared confirmation', () => {
    const onAction = vi.fn();
    render(
      <EphemeralMessage
        msg={{
          content: "Send wasn't confirmed — queued to retry automatically",
          action: {
            label: 'Discard…',
            handler: () => undefined,
            confirm: 'unconfirmed-discard',
          },
        }}
        idx={0}
        fontSize={14}
        isRemoving={false}
        onDismiss={vi.fn()}
        onAction={onAction}
      />,
    );
    const discard = screen.getByRole('button', { name: 'Discard…' });
    discard.focus();
    fireEvent.click(discard);
    expect(onAction).not.toHaveBeenCalled();
    const confirm = screen.getByRole('group', {
      name: 'Discard this message?',
    });
    expect(confirm.textContent).toContain(
      'It may already have reached the agent.',
    );
    // Discard… stays where it was, and focus moves into the question.
    expect(discard.isConnected).toBe(true);
    expect(discard.getAttribute('aria-controls')).toBe(confirm.id);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Keep it' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(
      screen.queryByRole('group', { name: 'Discard this message?' }),
    ).toBeNull();
    // Keep it hands focus back to Discard….
    expect(document.activeElement).toBe(discard);
    fireEvent.click(discard);
    fireEvent.click(
      screen.getByRole('button', { name: 'I checked, discard it' }),
    );
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
