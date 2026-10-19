// @vitest-environment jsdom

import {
  SESSION_INVENTORY_V2,
  SESSION_INVENTORY_V2_GROUP_IDS,
} from '@kontourai/station-contracts/session-inventory';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  SessionInventoryRequestError,
  sessionInventoryQueries,
  useSessionInventoryGroupPage,
  useSessionInventoryQuery,
} from '../session-inventory.js';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));

afterEach(() => vi.unstubAllGlobals());

/** Real sessions carry colon-shaped ids (`<engine>:<epoch-ms>`). */
const SESSION = 'muse:1792426448641';
const TURN = '527389e6-c183-400c-ae75-3002ee7a4ef4';

function wholeSession() {
  return {
    version: SESSION_INVENTORY_V2,
    scope: { kind: 'whole-session', sessionId: SESSION },
    groups: SESSION_INVENTORY_V2_GROUP_IDS.map((id) => ({
      id,
      owner: { owner: 'station.inventory', id: 'v1' },
      state: 'empty',
      count: { kind: 'exact', value: 0 },
      items: [],
      gaps: [],
    })),
  };
}

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mount(
  scope: Parameters<typeof useSessionInventoryQuery>[0],
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return {
    client,
    observer: renderHook(() => useSessionInventoryQuery(scope), { wrapper }),
  };
}

describe('session inventory query lifecycle', () => {
  /**
   * A current-answer projection whose Basis answer is unavailable is refused
   * by the contract parser; the error carries the response's own status (a
   * 200), not 0, which is reserved for no response at all. A 503 is a read
   * Station could not
   * perform. Neither is lost authority. Each must settle into one error the
   * surface can name, after exactly one read (retry is off). Before, any
   * refusal REMOVED the observed query; the observer re-created it and the
   * read refetched forever while the surface showed only its skeleton.
   */
  test.each([
    [
      'a projection the contract refuses',
      () =>
        respond(200, {
          success: true,
          data: {
            ...wholeSession(),
            scope: { kind: 'current-answer', sessionId: SESSION, turnId: TURN },
          },
        }),
      200,
    ],
    ['a 503', () => respond(503, { success: false }), 503],
  ])(
    '%s settles into one error without revoking or refetching',
    async (_label, answer, status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => answer());
      vi.stubGlobal('fetch', fetchMock);
      const scope = {
        kind: 'current-answer' as const,
        sessionId: SESSION,
        turnId: TURN,
      };
      const { client, observer } = mount(scope);

      await waitFor(() => {
        expect(observer.result.current.isLoading).toBe(false);
        expect(observer.result.current.error).toBeTruthy();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(observer.result.current.data).toBeUndefined();
      expect(
        (observer.result.current.error as SessionInventoryRequestError).status,
      ).toBe(status);
      // Not a revocation: nothing is tombstoned.
      expect(
        client.getQueryData(sessionInventoryQueries.projection(scope).queryKey),
      ).toBeUndefined();
    },
  );

  test('lost authority (404) settles after one read, tombstoned', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => respond(404, { success: false }));
    vi.stubGlobal('fetch', fetchMock);
    const scope = { kind: 'whole-session' as const, sessionId: SESSION };
    const { client, observer } = mount(scope);

    await waitFor(() => {
      expect(observer.result.current.isLoading).toBe(false);
      expect(observer.result.current.error).toBeTruthy();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      client.getQueryData(sessionInventoryQueries.projection(scope).queryKey),
    ).toBeNull();
  });

  /** First read succeeds; the background refetch is held until released. */
  async function loadedThenRefetching(second: () => Response) {
    let release: (() => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        respond(200, { success: true, data: wholeSession() }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(second());
          }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const scope = { kind: 'whole-session' as const, sessionId: SESSION };
    const { client, observer } = mount(scope);
    await waitFor(() => expect(observer.result.current.data).toBeTruthy());

    act(() => {
      void client.invalidateQueries({ queryKey: ['session-inventory'] });
    });
    await waitFor(() => expect(observer.result.current.isFetching).toBe(true));
    // In flight: what was loaded stays, and nothing reads as loading.
    expect(observer.result.current.data).toBeTruthy();
    expect(observer.result.current.isLoading).toBe(false);

    await act(async () => release?.());
    await waitFor(() => expect(observer.result.current.isFetching).toBe(false));
    return { client, observer, fetchMock, scope };
  }

  test('a background refetch keeps the loaded projection on screen', async () => {
    const { observer } = await loadedThenRefetching(() =>
      respond(200, { success: true, data: wholeSession() }),
    );
    expect(observer.result.current.data).toBeTruthy();
    expect(observer.result.current.error).toBeNull();
  });

  test('a background refetch that fails (503) keeps the content beside the error', async () => {
    const { observer } = await loadedThenRefetching(() =>
      respond(503, { success: false }),
    );
    expect(observer.result.current.data).toBeTruthy();
    expect(observer.result.current.error).toBeTruthy();
    expect(observer.result.current.isLoading).toBe(false);
  });

  test('a background refetch that loses authority (404) clears the content', async () => {
    const { client, observer, scope } = await loadedThenRefetching(() =>
      respond(404, { success: false }),
    );
    expect(observer.result.current.data).toBeUndefined();
    expect(observer.result.current.error).toBeTruthy();
    expect(
      client.getQueryData(sessionInventoryQueries.projection(scope).queryKey),
    ).toBeNull();
  });

  test('a mount still withholds cached data until its own read lands', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const scope = { kind: 'whole-session' as const, sessionId: SESSION };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      sessionInventoryQueries.projection(scope).queryKey,
      wholeSession(),
    );
    const { observer } = mount(scope, client);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(observer.result.current.data).toBeUndefined();
    expect(observer.result.current.isLoading).toBe(true);
  });

  /**
   * `isFetchedAfterMount` is also true after a FAILED read, so it cannot by
   * itself release data that was cached before this mount: a mount whose own
   * first read failed must not show what an earlier mount was authorized to
   * read.
   */
  test.each([
    ['a 503', async () => respond(503, { success: false })],
    [
      'a network failure',
      async (): Promise<Response> => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])(
    'a mount whose first read fails (%s) shows no previously cached projection',
    async (_label, answer) => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(answer);
      vi.stubGlobal('fetch', fetchMock);
      const scope = { kind: 'whole-session' as const, sessionId: SESSION };
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(
        sessionInventoryQueries.projection(scope).queryKey,
        wholeSession(),
      );
      const { observer } = mount(scope, client);

      await waitFor(() => {
        expect(observer.result.current.error).toBeTruthy();
        expect(observer.result.current.isFetching).toBe(false);
      });
      expect(observer.result.current.data).toBeUndefined();
      expect(observer.result.current.isLoading).toBe(false);
      // The cache itself is untouched: a 503 is not lost authority.
      expect(
        client.getQueryData(sessionInventoryQueries.projection(scope).queryKey),
      ).toBeTruthy();
    },
  );

  /**
   * The reviewer's probe: with a frozen clock this mount's own success lands
   * at the same `dataUpdatedAt` as the entry cached before it. A later failed
   * refresh must still keep what THIS mount loaded on screen.
   */
  test('a frozen clock does not hide data this mount loaded when a refresh then fails', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_792_426_448_641);
    try {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () =>
          respond(200, { success: true, data: wholeSession() }),
        )
        .mockImplementation(async () => respond(503, { success: false }));
      vi.stubGlobal('fetch', fetchMock);
      const scope = { kind: 'whole-session' as const, sessionId: SESSION };
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(
        sessionInventoryQueries.projection(scope).queryKey,
        wholeSession(),
      );
      const { observer } = mount(scope, client);
      await waitFor(() => expect(observer.result.current.data).toBeTruthy());

      await act(async () => {
        await client.invalidateQueries({ queryKey: ['session-inventory'] });
      });
      await waitFor(() => {
        expect(observer.result.current.isFetching).toBe(false);
        expect(observer.result.current.error).toBeTruthy();
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(observer.result.current.data).toBeTruthy();
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * Each mount, and each key a mounted hook switches to, makes its own read:
   * data is released only after one succeeds (above), so a read skipped
   * because the cached entry is still fresh would leave the hook loading
   * forever.
   */
  describe('every mount and key switch reads', () => {
    const other = 'codex:1792426448999';
    function projectionFor(sessionId: string) {
      return { ...wholeSession(), scope: { kind: 'whole-session', sessionId } };
    }
    function routedFetch() {
      return vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const sessionId = decodeURIComponent(
          /sessions\/([^/]+)\/inventory/.exec(String(input))![1]!,
        );
        return respond(200, { success: true, data: projectionFor(sessionId) });
      });
    }

    test('switching onto a key with a fresh cached entry fetches and shows it', async () => {
      const fetchMock = routedFetch();
      vi.stubGlobal('fetch', fetchMock);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const second = { kind: 'whole-session' as const, sessionId: other };
      // Fresh (well inside staleTime) before the hook ever reaches it.
      client.setQueryData(
        sessionInventoryQueries.projection(second).queryKey,
        projectionFor(other),
      );
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const observer = renderHook(
        ({ scope }) => useSessionInventoryQuery(scope),
        {
          wrapper,
          initialProps: {
            scope: { kind: 'whole-session', sessionId: SESSION } as {
              kind: 'whole-session';
              sessionId: string;
            },
          },
        },
      );
      await waitFor(() => expect(observer.result.current.data).toBeTruthy());

      observer.rerender({ scope: second });

      await waitFor(() =>
        expect(
          (observer.result.current.data as { scope: { sessionId: string } })
            ?.scope.sessionId,
        ).toBe(other),
      );
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes(encodeURIComponent(other)),
        ),
      ).toBe(true);
    });

    test('becoming enabled on a key with a fresh cached entry reads once and shows it', async () => {
      const fetchMock = routedFetch();
      vi.stubGlobal('fetch', fetchMock);
      const scope = { kind: 'whole-session' as const, sessionId: SESSION };
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(
        sessionInventoryQueries.projection(scope).queryKey,
        wholeSession(),
      );
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const observer = renderHook(
        ({ enabled }) => useSessionInventoryQuery(scope, { enabled }),
        { wrapper, initialProps: { enabled: false } },
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(observer.result.current.data).toBeUndefined();

      observer.rerender({ enabled: true });

      await waitFor(() => expect(observer.result.current.data).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('a caller asking not to refetch on mount still reads before showing', async () => {
      const fetchMock = routedFetch();
      vi.stubGlobal('fetch', fetchMock);
      const scope = { kind: 'whole-session' as const, sessionId: SESSION };
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(
        sessionInventoryQueries.projection(scope).queryKey,
        wholeSession(),
      );
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const observer = renderHook(
        () =>
          useSessionInventoryQuery(scope, {
            refetchOnMount: false,
            staleTime: 30_000,
          }),
        { wrapper },
      );

      await waitFor(() => expect(observer.result.current.data).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Lost authority on ANY read of a scope revokes everything held for that
   * scope, not only the read that was refused: a denied page must clear the
   * projection another observer already shows, and a denied projection must
   * clear a page another observer already shows. Both observers share one
   * client, as the compact inventory and the full pane do.
   */
  describe('a refusal on one read revokes the whole scope', () => {
    const scope = { kind: 'whole-session' as const, sessionId: SESSION };
    const page = () => ({
      version: SESSION_INVENTORY_V2,
      scope,
      group: {
        id: 'outputs',
        owner: { owner: 'station.inventory', id: 'v1' },
        state: 'empty',
        count: { kind: 'exact', value: 0 },
        items: [],
        gaps: [],
      },
    });

    function mountBoth(denied: 'projection' | 'page') {
      let refuse = false;
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockImplementation(async (input) => {
          const isPage = String(input).includes('/inventory/groups/');
          if (refuse && (denied === 'page') === isPage)
            return respond(404, { success: false });
          return respond(200, {
            success: true,
            data: isPage ? page() : wholeSession(),
          });
        }),
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const projection = renderHook(() => useSessionInventoryQuery(scope), {
        wrapper,
      });
      const pages = renderHook(
        () => useSessionInventoryGroupPage(scope, 'outputs', 'next'),
        { wrapper },
      );
      return {
        client,
        projection,
        pages,
        refuse: () => {
          refuse = true;
        },
      };
    }

    test('a denied page clears the loaded projection', async () => {
      const { client, projection, pages, refuse } = mountBoth('page');
      await waitFor(() => {
        expect(projection.result.current.data).toBeTruthy();
        expect(pages.result.current.data).toBeTruthy();
      });

      refuse();
      await act(async () => {
        await pages.result.current.refetch();
      });

      await waitFor(() =>
        expect(projection.result.current.data).toBeUndefined(),
      );
      expect(
        client.getQueryData(sessionInventoryQueries.projection(scope).queryKey),
      ).toBeNull();
    });

    test('a denied projection clears the loaded page', async () => {
      const { client, projection, pages, refuse } = mountBoth('projection');
      await waitFor(() => {
        expect(projection.result.current.data).toBeTruthy();
        expect(pages.result.current.data).toBeTruthy();
      });

      refuse();
      await act(async () => {
        await projection.result.current.refetch();
      });

      await waitFor(() => expect(pages.result.current.data).toBeUndefined());
      expect(
        client.getQueryData(
          sessionInventoryQueries.page(scope, 'outputs', 'next').queryKey,
        ),
      ).toBeNull();
    });
  });
});
