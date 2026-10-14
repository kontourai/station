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
    fireEvent.click(screen.getByRole('button', { name: 'Discard…' }));
    expect(onAction).not.toHaveBeenCalled();
    expect(
      screen.getByRole('group', { name: 'Discard this message?' }).textContent,
    ).toContain('It may already have reached the agent.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(
      screen.queryByRole('group', { name: 'Discard this message?' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discard…' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'I checked, discard it' }),
    );
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
