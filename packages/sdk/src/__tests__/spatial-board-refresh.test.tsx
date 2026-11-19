// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import {
  useResolvedSpatialBoardQuery,
  useSetSpatialBoardTitleMutation,
  useSpatialBoardQuery,
} from '../spatial-board';

vi.mock('../api', () => ({ _getApiBase: async () => 'http://station.test' }));
const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../client/http', () => ({ authenticatedFetch }));

const useBoard = () => ({
  board: useSpatialBoardQuery(),
  resolved: useResolvedSpatialBoardQuery(),
  title: useSetSpatialBoardTitleMutation(),
});

test('refreshes both Board observations on return and after a refused write without replay', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchOnMount: false, retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let revision = 1;
  let titleWrites = 0;
  authenticatedFetch.mockImplementation(
    async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        titleWrites++;
        return new Response(
          JSON.stringify({ success: false, code: 'spatial_board_conflict' }),
          { status: 409 },
        );
      }
      const data = url.endsWith('/resolved')
        ? { revision, pins: [] }
        : { revision, title: `Board ${revision}`, pins: [] };
      return new Response(JSON.stringify({ success: true, data }));
    },
  );
  const first = renderHook(useBoard, { wrapper });
  await waitFor(() => {
    expect(first.result.current.board.data?.revision).toBe(1);
    expect(first.result.current.resolved.data?.revision).toBe(1);
  });
  first.unmount();

  revision = 2;
  const returned = renderHook(useBoard, { wrapper });
  await waitFor(() => {
    expect(returned.result.current.board.data?.revision).toBe(2);
    expect(returned.result.current.resolved.data?.revision).toBe(2);
  });

  revision = 3;
  act(() =>
    returned.result.current.title.mutate({
      expectedRevision: 2,
      title: 'Draft',
    }),
  );
  await waitFor(() => {
    expect(returned.result.current.title.error).toMatchObject({
      conflict: true,
    });
    expect(returned.result.current.board.data?.revision).toBe(3);
    expect(returned.result.current.resolved.data?.revision).toBe(3);
  });
  expect(titleWrites).toBe(1);
  returned.unmount();
  client.clear();
});
