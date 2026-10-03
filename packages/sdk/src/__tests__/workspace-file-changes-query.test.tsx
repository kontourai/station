// @vitest-environment jsdom

/**
 * The File Preview's Changes read: a `503 repository-busy` answer (the
 * repository was being written while Station read it) is asked again when
 * the server suggests, a bounded number of times, and is then an error the
 * pane can tell from a failure; nothing else is retried.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { StationHttpError, setClientCredentialResolver } from '../client/http';
import {
  isRepositoryBusyError,
  useProjectWorkspaceFileChangesQuery,
} from '../workspace-file-preview';

const API_BASE = 'http://station.test';

beforeEach(() => {
  _setApiBase(API_BASE);
});

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** The route's busy answer, as `workspace-pane-previews.ts` sends it. */
function busy() {
  return new Response(
    JSON.stringify({
      success: false,
      error: 'The repository was being changed while Station read it',
      code: 'repository-busy',
      retryable: true,
    }),
    {
      status: 503,
      headers: { 'content-type': 'application/json', 'Retry-After': '0' },
    },
  );
}

function changed() {
  return new Response(
    JSON.stringify({
      success: true,
      data: { state: 'changed', base: 'HEAD', patch: 'diff --git a/x b/x\n' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function failed(status: number) {
  return new Response(
    JSON.stringify({ success: false, error: 'git could not read this file.' }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function read(fetch: typeof globalThis.fetch) {
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient();
  return renderHook(
    () =>
      useProjectWorkspaceFileChangesQuery('demo', {
        path: 'src/a.ts',
        thread: 'thread-7',
      }),
    { wrapper: wrapper(client) },
  );
}

describe('useProjectWorkspaceFileChangesQuery', () => {
  test('asks again after a busy answer, when the server said to, and then renders the read', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(changed());

    const observer = read(fetch);

    await waitFor(() =>
      expect(observer.result.current.data).toMatchObject({ state: 'changed' }),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      `${API_BASE}/api/projects/demo/file-preview/changes`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      path: 'src/a.ts',
      thread: 'thread-7',
    });
  });

  test('a repository that stays busy is an error the pane can tell apart, after a bounded number of further reads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => busy());

    const observer = read(fetch);

    await waitFor(() => expect(observer.result.current.isError).toBe(true));
    // The first read and two more.
    expect(fetch).toHaveBeenCalledTimes(3);
    const error = observer.result.current.error;
    expect(isRepositoryBusyError(error)).toBe(true);
    expect(error).toBeInstanceOf(StationHttpError);
    expect((error as StationHttpError).status).toBe(503);
  });

  test('any other failure is not retried and is not busy', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => failed(502));

    const observer = read(fetch);

    await waitFor(() => expect(observer.result.current.isError).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(isRepositoryBusyError(observer.result.current.error)).toBe(false);
  });

  test('isRepositoryBusyError names only the busy envelope', () => {
    expect(
      isRepositoryBusyError(
        new StationHttpError(503, 'busy', { code: 'repository-busy' }),
      ),
    ).toBe(true);
    expect(
      isRepositoryBusyError(
        new StationHttpError(409, 'refused', {
          code: 'git-dir-outside-project',
        }),
      ),
    ).toBe(false);
    expect(isRepositoryBusyError(new StationHttpError(503, 'busy'))).toBe(
      false,
    );
    expect(isRepositoryBusyError({ code: 'repository-busy' })).toBe(false);
    expect(isRepositoryBusyError(undefined)).toBe(false);
  });
});
