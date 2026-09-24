/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  useGitCommitMutation,
  useGitPushMutation,
} from '../hooks/useGitActions';

const ORIGIN = 'https://station.example.test';

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: ORIGIN }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { mutations: { retry: false } },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof respond>) {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

describe('coding commit and push requests (#2363)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('commit names the Project, and the repository only as a selection inside it', async () => {
    const fetchMock = respond(200, { success: true, data: { sha: 'abc' } });
    const { result } = renderHook(
      () => useGitCommitMutation('acme', '/work/acme/api'),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync({ message: 'change' });
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${ORIGIN}/api/coding/git/commit`,
    );
    expect(sentBody(fetchMock)).toEqual({
      projectSlug: 'acme',
      path: '/work/acme/api',
      message: 'change',
    });
  });

  test("a refused commit surfaces the server's sentence, naming the files", async () => {
    const error =
      'Not committed: .env (environment file) looks like secrets. Add them to .gitignore or remove them, then commit again';
    respond(409, {
      success: false,
      code: 'secrets',
      error,
      files: [{ path: '.env', reason: 'environment file' }],
    });
    const { result } = renderHook(() => useGitCommitMutation('acme', '/w'), {
      wrapper,
    });
    act(() => result.current.mutate({ message: 'change' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe(error);
  });

  test('push names the Project too', async () => {
    const fetchMock = respond(200, { success: true, data: { output: '' } });
    const { result } = renderHook(() => useGitPushMutation('acme', '/w'), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ setUpstream: true });
    });
    expect(sentBody(fetchMock)).toEqual({
      projectSlug: 'acme',
      path: '/w',
      setUpstream: true,
    });
  });
});
