/**
 * @vitest-environment jsdom
 */

import { setClientCredentialResolver } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useReposQuery } from '../hooks/useGitActions';

const ORIGIN = 'https://station.example.test';

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: ORIGIN }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

describe('coding repository remote authentication', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  test('sends the current bearer credential to coding repository discovery', async () => {
    setClientCredentialResolver(() => ({
      credential: 'remote-repo-credential',
      origin: ORIGIN,
    }));
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                workspace: '/work',
                workspaceIsRepo: true,
                repos: [],
              },
            }),
          ),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useReposQuery('/work'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer remote-repo-credential',
    );
  });

  test('reports rejection once and recovers with a replacement credential', async () => {
    let credential = 'expired-repo-credential';
    const onUnauthorized = vi.fn();
    setClientCredentialResolver(() => ({
      credential,
      origin: ORIGIN,
      onUnauthorized,
    }));
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        if (credential === 'expired-repo-credential') {
          return new Response(JSON.stringify({ success: false }), {
            status: 401,
          });
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              workspace: '/work',
              workspaceIsRepo: true,
              repos: [
                {
                  root: '/work',
                  name: 'work',
                  relativePath: '.',
                  branch: 'main',
                },
              ],
            },
          }),
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useReposQuery('/work'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(onUnauthorized).toHaveBeenCalledOnce();

    credential = 'replacement-repo-credential';
    const recovery = await result.current.refetch();

    expect(recovery.data?.repos).toHaveLength(1);
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer replacement-repo-credential',
    );
  });
});
