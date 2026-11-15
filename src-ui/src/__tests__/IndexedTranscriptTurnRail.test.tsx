// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { IndexedTranscriptTurnRail } from '../components/chat/IndexedTranscriptTurnRail';

const directory = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/client', () => ({
  getConversationTurnDirectory: directory,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'person',
    isCurrent: () => true,
  }),
}));
afterEach(cleanup);

test('the rail pages all turn metadata independently of loaded history and cancels an unloaded jump on close', async () => {
  directory.mockImplementation(async (_base, _conversation, cursor) => ({
    session: { conversationId: 'conversation', turnCount: 3 },
    turns: cursor
      ? [
          {
            turnId: 'oldest',
            request: 'Original request',
            outcome: 'completed',
          },
        ]
      : [
          { turnId: 'newest', request: 'Current request', outcome: 'open' },
          { turnId: 'older', request: 'Older request', outcome: 'completed' },
        ],
    nextCursor: cursor ? null : 'older-page',
  }));
  const load = vi.fn(
    (_turnId: string, _signal: AbortSignal) => new Promise<boolean>(() => {}),
  );
  const jump = vi.fn();
  const { unmount } = render(
    <QueryClientProvider client={new QueryClient()}>
      <IndexedTranscriptTurnRail
        conversationId="conversation"
        onLoadTurn={load}
        landmarks={[
          {
            turnId: 'newest',
            rowId: 'u3',
            prompt: 'Current request',
            rowIndex: 0,
            endRowIndex: 2,
          },
        ]}
        rowCount={2}
        scrollElement={createRef()}
        railRef={createRef()}
        activeTurn={0}
        activeStartVisible
        onJump={jump}
        olderHistory
        previousTurn={undefined}
        nextTurn={undefined}
        onStep={jump}
        touchControls={false}
      />
    </QueryClientProvider>,
  );
  const oldest = await screen.findByRole('button', {
    name: 'Turn 1 of 3: Original request',
  });
  expect(directory).toHaveBeenCalledTimes(2);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(oldest);
  await waitFor(() =>
    expect(load).toHaveBeenCalledWith('oldest', expect.any(AbortSignal)),
  );
  expect(jump).not.toHaveBeenCalled();
  const signal = load.mock.calls[0][1];
  fireEvent.click(
    screen.getByRole('button', { name: 'Turn 3 of 3: Current request' }),
  );
  expect(signal.aborted).toBe(true);
  expect(jump).toHaveBeenCalledWith(0);
  fireEvent.click(oldest);
  unmount();
  expect(load.mock.calls[1][1].aborted).toBe(true);
});
