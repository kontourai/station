// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { TranscriptTurnBrowser } from '../components/chat/TranscriptTurnBrowser';

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
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set(['session-cli-reads']),
}));

test('loads turn metadata before requesting transcript pages, then loads only the selected turn', async () => {
  directory.mockResolvedValue({
    session: { conversationId: 'conversation', turnCount: 200 },
    turns: [
      {
        turnId: 'old-turn',
        startedAt: '2026-10-30T12:00:00Z',
        request: 'Investigate the older failure',
        outcome: 'completed',
      },
    ],
    nextCursor: null,
  });
  const load = vi.fn().mockResolvedValue(true);
  const close = vi.fn();
  const jump = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TranscriptTurnBrowser
        conversationId="conversation"
        landmarks={[]}
        onJumpLoaded={jump}
        onLoadTurn={load}
        onClose={close}
      />
    </QueryClientProvider>,
  );
  const turn = await screen.findByRole('button', {
    name: /Investigate the older failure/,
  });
  expect(directory).toHaveBeenCalledWith(
    'http://station.test',
    'conversation',
    undefined,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(turn);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(load).toHaveBeenCalledWith('old-turn', expect.any(AbortSignal));
  expect(jump).not.toHaveBeenCalled();
});
