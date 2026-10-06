/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const moveUpMock = vi.fn();
const moveDownMock = vi.fn();
const removeMock = vi.fn();
const startEditMock = vi.fn();

vi.mock('../hooks/useQueuedMessages', () => ({
  useQueuedMessages: () => ({
    editingIndex: null,
    editValue: '',
    setEditValue: vi.fn(),
    startEdit: startEditMock,
    cancelEdit: vi.fn(),
    saveEdit: vi.fn(),
    remove: removeMock,
    moveUp: moveUpMock,
    moveDown: moveDownMock,
  }),
}));

import { QueuedMessages } from '../components/chat/QueuedMessages';

function renderQueue(ui: Parameters<typeof render>[0]) {
  const result = render(ui);
  const toggle = screen.queryByRole('button', { name: /pending messages?/ });
  if (toggle) fireEvent.click(toggle);
  return result;
}

describe('pending message disclosure', () => {
  it('starts compact, announces required review, and reveals actions only after expansion', () => {
    render(
      <QueuedMessages
        sessionId="s1"
        messages={['Held input']}
        metadata={[{ id: 'held-id', mode: 'steer', delivery: 'indeterminate' }]}
        canSteer
        onSteer={async () => false}
      />,
    );
    const toggle = screen.getByRole('button', {
      name: '1 pending message, needs review',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Retry steering' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Retry steering' }),
    ).not.toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'Retry steering' })).toBeNull();
  });
});

describe('#3157 usage-limit hold', () => {
  it('says why the queue is held, even while collapsed, and only while held', () => {
    const { rerender } = render(
      <QueuedMessages sessionId="s1" messages={['next']} heldByUsageLimit />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Held because of the usage limit. Send now to send anyway.',
    );
    rerender(<QueuedMessages sessionId="s1" messages={['next']} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('pending message actions', () => {
  it('shows persisted mode and coalesces repeated Send now clicks for the selected row', async () => {
    let resolve!: () => void;
    const onSendMessageNow = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    renderQueue(
      <QueuedMessages
        sessionId="s1"
        messages={['first', 'second']}
        metadata={[
          { id: 'first-id', mode: 'queue' },
          { id: 'second-id', mode: 'steer' },
        ]}
        onSendMessageNow={onSendMessageNow}
      />,
    );
    expect(screen.getByText('Queue · Queued for next turn')).not.toBeNull();
    expect(
      screen.getByText(/Steer · Waiting for this turn to finish/),
    ).not.toBeNull();
    const button = screen.getByRole('button', {
      name: 'Send pending message 2 now',
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSendMessageNow).toHaveBeenCalledExactlyOnceWith('second-id');
    await act(async () => {
      resolve();
    });
  });
});

describe('QueuedMessages — reorder buttons (#613)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders order numbers 1 = next-to-send on a display list reversed from array order', () => {
    renderQueue(
      <QueuedMessages sessionId="s1" messages={['first', 'second', 'third']} />,
    );

    // Displayed newest-queued-first (reverse of send order): 'third' (order
    // 3) renders before 'first' (order 1, next to send).
    const orderNumbers = screen
      .getAllByText(/^[1-3]$/)
      .map((node) => node.textContent);
    expect(orderNumbers).toEqual(['3', '2', '1']);
  });

  it('disables the visual-up button only for the top rendered row (real last index)', () => {
    renderQueue(
      <QueuedMessages sessionId="s1" messages={['first', 'second', 'third']} />,
    );

    const upButtons = screen.getAllByRole('button', {
      name: 'Move message up',
    }) as HTMLButtonElement[];
    // Display order is reversed: 'third' (real last index) renders at the
    // TOP — it cannot move visually up any further.
    expect(upButtons[0].disabled).toBe(true); // 'third' — already at top
    expect(upButtons[1].disabled).toBe(false); // 'second'
    expect(upButtons[2].disabled).toBe(false); // 'first'
  });

  it('disables the visual-down button only for the bottom rendered row (real index 0, next to send)', () => {
    renderQueue(
      <QueuedMessages sessionId="s1" messages={['first', 'second', 'third']} />,
    );

    const downButtons = screen.getAllByRole('button', {
      name: 'Move message down',
    }) as HTMLButtonElement[];
    // 'first' (real index 0, next to send) renders at the BOTTOM — it
    // cannot move visually down any further.
    expect(downButtons[0].disabled).toBe(false); // 'third'
    expect(downButtons[1].disabled).toBe(false); // 'second'
    expect(downButtons[2].disabled).toBe(true); // 'first' — already at bottom
  });

  it('visual direction maps to the correct real-array operation (review #613-1)', () => {
    renderQueue(
      <QueuedMessages sessionId="s1" messages={['first', 'second', 'third']} />,
    );

    // The rendered list is reversed (next-to-send at the bottom), so a
    // VISUAL up-click must move the row to a HIGHER real index (drains
    // later) = the hook's moveDown, and a visual down-click to a LOWER
    // real index (drains sooner) = the hook's moveUp.
    const upButtons = screen.getAllByRole('button', {
      name: 'Move message up',
    });
    // Display position 1 is 'second', real index 1; visual up = moveDown.
    fireEvent.click(upButtons[1]);
    expect(moveDownMock).toHaveBeenCalledWith(1, 3);

    const downButtons = screen.getAllByRole('button', {
      name: 'Move message down',
    });
    // Display position 0 is 'third', real index 2; visual down = moveUp.
    fireEvent.click(downButtons[0]);
    expect(moveUpMock).toHaveBeenCalledWith(2);
  });

  it('marks every queue action as a non-submit button', () => {
    renderQueue(
      <QueuedMessages sessionId="s1" messages={['first', 'second', 'third']} />,
    );

    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).type).toBe('button');
    }
  });

  it('renders nothing for an empty queue', () => {
    const { container } = renderQueue(
      <QueuedMessages sessionId="s1" messages={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it.each([
    { capable: false, active: false, visible: false },
    { capable: true, active: false, visible: false },
    { capable: false, active: true, visible: false },
    { capable: true, active: true, visible: true },
  ])(
    'gates Send as steer for capability=$capable active=$active',
    ({ capable, active, visible }) => {
      renderQueue(
        <QueuedMessages
          sessionId="s1"
          messages={['redirect']}
          canSteer={capable && active}
          onSteer={vi.fn().mockResolvedValue(true)}
        />,
      );
      expect(
        screen.queryByRole('button', { name: 'Send as steer' }) !== null,
      ).toBe(visible);
    },
  );

  it('dispatches a rapid double activation once while the row is pending', async () => {
    let resolve!: (sent: boolean) => void;
    const onSteer = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    renderQueue(
      <QueuedMessages
        sessionId="s1"
        messages={['redirect']}
        canSteer
        onSteer={onSteer}
      />,
    );
    const button = screen.getByRole('button', { name: 'Send as steer' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onSteer).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(false));
  });

  // a retained follow-up used to sit in the queue with no reason
  // and no way to send it — the automatic drain only fires on a later
  // turn.completed, so a refusal the user has since fixed stranded it.
  it('explains why the queue is held and offers a retry', () => {
    const onRetry = vi.fn();
    renderQueue(
      <QueuedMessages
        sessionId="s1"
        messages={['keep this follow-up']}
        failure={{
          message:
            'This conversation was started without a workspace, so it cannot be continued inside one.',
          code: 'continuation_workspace_unbound',
          at: 1,
        }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText(/started without a workspace/i)).toBeTruthy();
    // on this refusal the action is not a plain retry —
    // it continues the conversation without the workspace — so the label says
    // that rather than promising a repeat of a deterministic failure.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Send the queued message to this conversation as it is',
      }),
    );
    expect(screen.getByText('Continue as is')).toBeTruthy();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers a plain retry for a transient refusal', () => {
    const onRetry = vi.fn();
    renderQueue(
      <QueuedMessages
        sessionId="s1"
        messages={['retry me']}
        failure={{
          message: 'Refused for now.',
          code: 'adoption_continuation_in_progress',
          at: 1,
        }}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry the queued message' }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows no refusal row when the queue is simply waiting its turn', () => {
    renderQueue(<QueuedMessages sessionId="s1" messages={['waiting']} />);
    expect(
      screen.queryByRole('button', { name: 'Retry the queued message' }),
    ).toBeNull();
  });

  it('leaves receipt retirement to the caller after concurrent queue changes', async () => {
    let resolve!: (sent: boolean) => void;
    const onSteer = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const onPendingSettled = vi.fn();
    const { rerender } = renderQueue(
      <QueuedMessages
        sessionId="s1"
        messages={['first', 'redirect', 'last']}
        canSteer
        onSteer={onSteer}
        onPendingSettled={onPendingSettled}
      />,
    );
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Send as steer' })[1],
    );
    rerender(
      <QueuedMessages
        sessionId="s1"
        messages={['redirect', 'last']}
        canSteer
        onSteer={onSteer}
        onPendingSettled={onPendingSettled}
      />,
    );
    await act(async () => resolve(true));

    expect(removeMock).not.toHaveBeenCalled();
    expect(onPendingSettled).toHaveBeenCalledTimes(1);
  });
});
