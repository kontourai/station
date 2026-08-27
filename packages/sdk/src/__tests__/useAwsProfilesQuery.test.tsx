/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { useAwsProfilesQuery } from '../query-domains/agentAdmin';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useAwsProfilesQuery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('fetches the AWS profile-name list from /api/models/aws-profiles', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          data: { profiles: ['default', 'work'], available: true },
        }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useAwsProfilesQuery({ retry: false }), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() =>
      expect(result.current.data).toEqual({
        profiles: ['default', 'work'],
        available: true,
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      'https://station.example.test/api/models/aws-profiles',
    );
  });

  test('surfaces a safe error when the route reports failure', async () => {
    _setApiBase('https://station.example.test');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ success: false, error: 'listing failed' }),
        ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useAwsProfilesQuery({ retry: false }), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: 'listing failed' });
  });
});
