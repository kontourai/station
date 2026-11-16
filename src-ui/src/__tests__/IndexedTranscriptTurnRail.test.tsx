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
  expect(directory.mock.calls[1][3]).toMatchObject({ turnCountSnapshot: 3 });
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

test('loading a focused indexed tick keeps its DOM identity and indexed steps announce the destination', async () => {
  directory.mockResolvedValue({
    session: { conversationId: 'conversation', turnCount: 2 },
    turns: [
      { turnId: 'newest', request: 'Latest request', outcome: 'completed' },
      { turnId: 'oldest', request: 'First request', outcome: 'completed' },
    ],
    nextCursor: null,
  });
  const client = new QueryClient();
  const announce = vi.fn();
  const load = vi.fn().mockResolvedValue(true);
  const props = {
    conversationId: 'conversation',
    onLoadTurn: load,
    onAnnounceStep: announce,
    rowCount: 2,
    scrollElement: createRef<HTMLDivElement>(),
    railRef: createRef<HTMLElement>(),
    activeTurn: 0,
    activeStartVisible: true,
    onJump: vi.fn(),
    olderHistory: true,
    previousTurn: undefined,
    nextTurn: undefined,
    onStep: vi.fn(),
    touchControls: false,
  };
  const newest = {
    turnId: 'newest',
    rowId: 'u2',
    prompt: 'Latest request',
    rowIndex: 0,
    endRowIndex: 2,
  };
  const view = (landmarks: (typeof newest)[]) => (
    <QueryClientProvider client={client}>
      <IndexedTranscriptTurnRail
        {...props}
        landmarks={landmarks}
        activeTurn={landmarks.length - 1}
      />
    </QueryClientProvider>
  );
  const { rerender } = render(view([newest]));
  const oldest = await screen.findByRole('button', {
    name: 'Turn 1 of 2: First request',
  });
  oldest.focus();
  rerender(
    view([
      {
        turnId: 'oldest',
        rowId: 'u1',
        prompt: 'First request',
        rowIndex: 0,
        endRowIndex: 2,
      },
      { ...newest, rowIndex: 2, endRowIndex: 4 },
    ]),
  );
  expect(document.activeElement).toBe(oldest);
  fireEvent.click(screen.getByRole('button', { name: 'Previous turn' }));
  await waitFor(() =>
    expect(announce).toHaveBeenCalledWith('Turn 1 of 2: First request'),
  );
});
