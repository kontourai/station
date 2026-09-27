/** @vitest-environment jsdom */

/**
 * #480 identity-lifetime review — BEHAVIOR proof over the REAL hook and
 * transport (fetch stubbed, nothing else mocked):
 *
 * A slug-keyed identity cache cannot distinguish a Project incarnation from
 * its delete/recreate replacement under the SAME Home+slug, and react-query
 * keeps the last success while refetching. With `expectedProjectId` the
 * incarnation joins the cache key AND the response's
 * `association.localProjectId` is validated — the old incarnation's portable
 * id or resources can never be delivered as success, no matter whether the
 * wrong data arrives from cache, from a held/lATE response, or from a stale
 * server payload. Legacy callers (no expectedProjectId) keep the prior
 * behavior byte-for-byte.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ClientCredential } from '../client/http';
import { setClientCredentialResolver } from '../client/http';
import {
  ProjectIdentityIncarnationMismatchError,
  useProjectIdentityQuery,
} from '../query-domains/workspaceProjects';

const API_BASE = 'https://home-a.example.test';

function identityView(localProjectId: string, portableId: string) {
  return {
    identity: {
      schemaVersion: 1,
      id: portableId,
      repos: [
        {
          kind: 'git' as const,
          id: 'git.example/acme/repo',
          canonicalRemote: 'git.example/acme/repo',
        },
      ],
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
    association: {
      portableProjectId: portableId,
      localProjectId,
      localProjectSlug: 'x',
    },
  };
}

function identityResponse(localProjectId: string, portableId: string) {
  return new Response(
    JSON.stringify({
      success: true,
      data: identityView(localProjectId, portableId),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

type Release = (response: Response) => void;

/**
 * Fetch stub whose responses are held until released, FIFO per call order.
 * Each call is recorded so the test can prove WHICH read a release answers.
 */
function deferredFetch() {
  const calls: Array<{ url: string; release: Release }> = [];
  const fetchMock = vi.fn<typeof fetch>((input: unknown) => {
    let release!: Release;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    calls.push({ url: String(input), release });
    return gate;
  });
  return {
    fetchMock,
    calls,
    release(index: number, response: Response) {
      calls[index]!.release(response);
    },
  };
}

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

// No retries: each test observes ONE read per expectation, and a retried
// query would silently turn the first wrong-answer response into a later
// fresh one (hiding exactly the behavior under test).
function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

const SCOPE = { apiBase: API_BASE, authorityKey: 'authority-a' };

// The scoped transport resolves a credential whose captured authority must
// match the request scope; without a resolver the read refuses before any
// fetch (StationRequestAuthorityError), so EVERY test installs the matching
// record — the same shape the authority tests use.
beforeEach(() => {
  setClientCredentialResolver(
    () =>
      ({
        origin: API_BASE,
        credential: 'sdk-test-credential-not-for-production',
        requestAuthority: {
          apiBase: API_BASE,
          authorityKey: 'authority-a',
          isCurrent: () => true,
        },
      }) satisfies ClientCredential,
  );
});

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

describe('useProjectIdentityQuery incarnation binding (#480 review)', () => {
  test('a held old-incarnation read resolved late never satisfies the recreated Project', async () => {
    const { fetchMock, release } = deferredFetch();
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();

    // Incarnation A is selected and its identity read starts.
    const { result, rerender } = renderHook(
      ({ expectedProjectId }: { expectedProjectId?: string }) =>
        useProjectIdentityQuery('x', {
          requestScope: SCOPE,
          expectedProjectId,
        }),
      {
        wrapper: wrapperFor(client),
        initialProps: { expectedProjectId: 'proj-A' },
      },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    // The SAME slug is deleted and recreated as incarnation B while the A
    // read is still held. The incarnation is part of the KEY, so the
    // recreated Project gets its OWN cache entry and its own read.
    rerender({ expectedProjectId: 'proj-B' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The OLD read resolves late: with the incarnation in the key it can
    // only ever land in the detached A entry — the CURRENT render (B) does
    // not flip to success and never sees A's portable id or resources.
    await act(async () => {
      release(0, identityResponse('proj-A', 'portable:A'));
    });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.data).toBeUndefined();

    // The recreated Project's own read resolves: only now does the current
    // selection succeed, with B's identity.
    await act(async () => {
      release(1, identityResponse('proj-B', 'portable:B'));
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.association.localProjectId).toBe('proj-B');
    expect(result.current.data?.identity.id).toBe('portable:B');
  });

  test('a stale server payload naming the wrong incarnation is an error, never success', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(identityResponse('proj-A', 'portable:A'));
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();

    const { result } = renderHook(
      () =>
        useProjectIdentityQuery('x', {
          requestScope: SCOPE,
          expectedProjectId: 'proj-B',
          retry: false,
        }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    // The wrong-incarnation answer is refused outright: no success data, so
    // no old portable id and no old resource can be used.
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(
      ProjectIdentityIncarnationMismatchError,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('correct association on fresh data restores the identity', async () => {
    let next = identityResponse('proj-A', 'portable:A');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      const response = next;
      next = identityResponse('proj-B', 'portable:B');
      return Promise.resolve(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();

    const { result } = renderHook(
      () =>
        useProjectIdentityQuery('x', {
          requestScope: SCOPE,
          expectedProjectId: 'proj-B',
          retry: false,
        }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();

    // The server answers with the CURRENT incarnation: the same selection
    // recovers through the ordinary refetch path — no guess, no fallback,
    // no implicit prepare.
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.association.localProjectId).toBe('proj-B');
    expect(result.current.data?.identity.id).toBe('portable:B');
  });

  test('legacy callers without expectedProjectId keep the slug-keyed behavior', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => identityResponse('proj-A', 'portable:A'));
    vi.stubGlobal('fetch', fetchMock);
    const client = newClient();

    const { result } = renderHook(
      () => useProjectIdentityQuery('x', { requestScope: SCOPE, retry: false }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // No expected incarnation: the response is delivered as-is, exactly the
    // prior contract.
    expect(result.current.data?.association.localProjectId).toBe('proj-A');
  });
});
