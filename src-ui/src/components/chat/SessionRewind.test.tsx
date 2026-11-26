// @vitest-environment jsdom

/**
 * "Rewind conversation to here" on a user turn: offered only where the live
 * session's engine declares an in-place rewind, confirmed, then sent to the
 * session that ran the turn. The SDK hooks are the seam mocked here; the
 * route, the client and the adapter have their own tests.
 */

import type { SessionLiveContinuity } from '@kontourai/station-contracts/provider';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionRewindProvider, useSessionRewindAction } from './SessionRewind';
import { UserMessageActionsMenu } from './TurnActionsMenu';

const mutateAsync = vi.hoisted(() => vi.fn());
const continuity = vi.hoisted(() => ({
  current: { live: true, rewind: 'in-place', fork: 'none' } as
    | SessionLiveContinuity
    | undefined,
}));
const refetch = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', () => ({
  useSessionLiveContinuityQuery: () => ({
    data: continuity.current,
    refetch,
  }),
  useRewindSessionToTurnMutation: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('../../utils/errorText', () => ({
  userFacingErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  refetch.mockReset();
  continuity.current = { live: true, rewind: 'in-place', fork: 'none' };
});

function Row(props: {
  sessionId?: string;
  turnId?: string;
  rewound?: boolean;
}) {
  const onRewindToHere = useSessionRewindAction({ role: 'user', ...props });
  return onRewindToHere ? (
    <UserMessageActionsMenu onRewindToHere={onRewindToHere} />
  ) : (
    <p>no actions</p>
  );
}

function view(
  row: { sessionId?: string; turnId?: string; rewound?: boolean },
  options: { executionThreadId?: string } = { executionThreadId: 'session-1' },
) {
  return render(
    <SessionRewindProvider executionThreadId={options.executionThreadId}>
      <Row {...row} />
    </SessionRewindProvider>,
  );
}

const openMenuAndRewind = () => {
  fireEvent.click(screen.getByRole('button', { name: 'More message actions' }));
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Rewind conversation to here' }),
  );
};

describe('Rewind conversation to here', () => {
  test('a confirmed rewind is sent to the session that ran the turn, and the dialog closes', async () => {
    mutateAsync.mockResolvedValue({
      kind: 'rewound',
      beforeTurnId: 'turn-2',
      hiddenTurnIds: ['turn-2'],
    });
    view({ sessionId: 'session-1', turnId: 'turn-2' });
    openMenuAndRewind();
    expect(
      screen.getByRole('dialog', { name: 'Rewind conversation to here?' }),
    ).toBeTruthy();
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }));
    expect(mutateAsync).toHaveBeenCalledWith({
      threadId: 'session-1',
      turnId: 'turn-2',
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Rewind conversation to here?' }),
      ).toBeNull(),
    );
  });

  test("a refusal stays in the dialog, says why, and re-reads the session's continuity", async () => {
    mutateAsync.mockResolvedValue({ kind: 'refused', reason: 'turn-running' });
    view({ sessionId: 'session-1', turnId: 'turn-2' });
    openMenuAndRewind();
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }));
    expect(
      await screen.findByText('Stop the running turn, then rewind.'),
    ).toBeTruthy();
    expect(refetch).toHaveBeenCalled();
  });

  test("the engine's own failure is shown as the engine said it", async () => {
    mutateAsync.mockResolvedValue({
      kind: 'failed',
      message: 'Cannot revert while the agent is still running',
    });
    view({ sessionId: 'session-1', turnId: 'turn-2' });
    openMenuAndRewind();
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }));
    expect(
      await screen.findByText(
        'The agent did not rewind: Cannot revert while the agent is still running',
      ),
    ).toBeTruthy();
  });

  test.each([
    [
      'the engine declares no rewind',
      { live: true, rewind: 'none', fork: 'none' } as const,
      { sessionId: 'session-1', turnId: 'turn-2' },
    ],
    [
      'no engine holds the session',
      { live: false, rewind: 'none', fork: 'none' } as const,
      { sessionId: 'session-1', turnId: 'turn-2' },
    ],
    [
      'the continuity is not read yet',
      undefined,
      { sessionId: 'session-1', turnId: 'turn-2' },
    ],
    [
      'the turn ran on an earlier session',
      { live: true, rewind: 'in-place', fork: 'none' } as const,
      { sessionId: 'session-0', turnId: 'turn-1' },
    ],
    [
      'the turn is already rewound',
      { live: true, rewind: 'in-place', fork: 'none' } as const,
      { sessionId: 'session-1', turnId: 'turn-2', rewound: true },
    ],
  ])('nothing is offered when %s', (_case, declared, row) => {
    continuity.current = declared;
    view(row);
    expect(screen.getByText('no actions')).toBeTruthy();
  });

  test('a turn starting or ending re-reads the continuity, so an engine started by that turn is seen', () => {
    const tree = (openTurnId?: string) => (
      <SessionRewindProvider
        executionThreadId="session-1"
        openTurnId={openTurnId}
      >
        <Row sessionId="session-1" turnId="turn-2" />
      </SessionRewindProvider>
    );
    const { rerender } = render(tree());
    expect(refetch).not.toHaveBeenCalled();
    rerender(tree('turn-3'));
    expect(refetch).toHaveBeenCalledTimes(1);
    rerender(tree('turn-3'));
    expect(refetch).toHaveBeenCalledTimes(1);
    rerender(tree(undefined));
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  test('a read-only view offers nothing', () => {
    view({ sessionId: 'session-1', turnId: 'turn-2' }, {});
    expect(screen.getByText('no actions')).toBeTruthy();
  });
});
