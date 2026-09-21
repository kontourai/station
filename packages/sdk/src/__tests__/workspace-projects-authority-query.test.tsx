// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  useProjectQuery,
  useProjectsQuery,
} from '../query-domains/workspaceProjects';

const scopeA = {
  apiBase: 'http://station.test',
  authorityKey: 'connection-a:generation-1',
};
const scopeB = {
  apiBase: 'http://station.test',
  authorityKey: 'connection-b:generation-2',
};

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

function response(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }));
}

describe('Project query authority scope', () => {
  test('Project lists at one endpoint remain distinct across connection authorities', async () => {
    let active = scopeA;
    setClientCredentialResolver(() => ({
      origin: active.apiBase,
      requestAuthority: { ...active, isCurrent: () => true },
    }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response([{ slug: 'shared-slug', name: 'A' }]))
      .mockResolvedValueOnce(response([{ slug: 'shared-slug', name: 'B' }]));
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      ({ requestScope }) =>
        useProjectsQuery({ requestScope, requireRequestScope: true }),
      { wrapper: wrapper(client), initialProps: { requestScope: scopeA } },
    );
    await waitFor(() =>
      expect(observer.result.current.data).toEqual([
        { slug: 'shared-slug', name: 'A' },
      ]),
    );
    active = scopeB;
    observer.rerender({ requestScope: scopeB });
    expect(observer.result.current.data).toBeUndefined();
    await waitFor(() =>
      expect(observer.result.current.data).toEqual([
        { slug: 'shared-slug', name: 'B' },
      ]),
    );
    expect(client.getQueryData(['projects'])).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('same-origin authorities with colliding slugs stay partitioned and reject the late old body', async () => {
    let active = scopeA;
    setClientCredentialResolver(() => {
      const captured = active;
      return {
        origin: captured.apiBase,
        requestAuthority: {
          ...captured,
          isCurrent: () => active === captured,
        },
      };
    });
    let releaseA!: (value: Response) => void;
    let releaseB!: (value: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseA = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseB = resolve)),
      );
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      ({ requestScope }) =>
        useProjectQuery('shared-slug', {
          requestScope,
          requireRequestScope: true,
        }),
      { wrapper: wrapper(client), initialProps: { requestScope: scopeA } },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    active = scopeB;
    observer.rerender({ requestScope: scopeB });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(observer.result.current.data).toBeUndefined();
    await act(async () =>
      releaseB(response({ slug: 'shared-slug', name: 'B' })),
    );
    await waitFor(() =>
      expect(observer.result.current.data).toMatchObject({ name: 'B' }),
    );
    await act(async () =>
      releaseA(response({ slug: 'shared-slug', name: 'PRIVATE_A' })),
    );
    expect(observer.result.current.data).toMatchObject({ name: 'B' });
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain('PRIVATE_A');
  });

  test('missing required authority stays inert under manual refetch despite primed legacy data', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(['projects'], [{ slug: 'legacy-private' }]);
    client.setQueryData(['projects', 'shared-slug'], {
      slug: 'shared-slug',
      name: 'legacy-private',
    });
    const list = renderHook(
      () =>
        useProjectsQuery({
          requestScope: undefined,
          requireRequestScope: true,
          retry: false,
        }),
      { wrapper: wrapper(client) },
    );
    const detail = renderHook(
      () =>
        useProjectQuery('shared-slug', {
          requestScope: undefined,
          requireRequestScope: true,
          retry: false,
        }),
      { wrapper: wrapper(client) },
    );
    expect(list.result.current.data).toBeUndefined();
    expect(detail.result.current.data).toBeUndefined();
    await act(async () => {
      await expect(list.result.current.refetch()).resolves.toMatchObject({
        error: { name: 'StationRequestAuthorityError' },
      });
      await expect(detail.result.current.refetch()).resolves.toMatchObject({
        error: { name: 'StationRequestAuthorityError' },
      });
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('captures immutable authority scalars before a caller mutates its scope object', async () => {
    const mutableScope = { ...scopeA };
    setClientCredentialResolver(() => ({
      origin: scopeA.apiBase,
      requestAuthority: { ...scopeA, isCurrent: () => true },
    }));
    let releaseCaptured!: (value: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseCaptured = resolve)),
      )
      .mockRejectedValue(new Error('replacement authority withheld'));
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = renderHook(
      () =>
        useProjectQuery('shared-slug', {
          requestScope: mutableScope,
          requireRequestScope: true,
          retry: false,
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    mutableScope.apiBase = 'http://attacker.test';
    mutableScope.authorityKey = 'replacement';
    await act(async () =>
      releaseCaptured(response({ slug: 'shared-slug', name: 'Captured' })),
    );
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'http://station.test/api/projects/shared-slug',
    );
    await waitFor(() =>
      expect(
        client.getQueryData([
          'projects',
          'shared-slug',
          'detail',
          scopeA.apiBase,
          scopeA.authorityKey,
        ]),
      ).toMatchObject({ name: 'Captured' }),
    );
    expect(observer.result.current.data).toBeUndefined();
    expect(
      client.getQueryData([
        'projects',
        'shared-slug',
        'detail',
        'http://attacker.test',
        'replacement',
      ]),
    ).toBeUndefined();
  });
});
