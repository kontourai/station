/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { StationHttpError } from '../client/http';
import {
  useCreateLocalSkillMutation,
  useUpdateLocalSkillMutation,
} from '../query-domains/skills';

/**
 * #2708 A-1: the local skill save hooks go through `createLocalSkill` /
 * `updateLocalSkill`. These drive the REAL hooks and fetchers (only the
 * transport is stubbed), so a hook reverted to its old inline fetch, or a
 * fetcher aimed at the wrong route, fails here.
 */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sent(call: unknown[]): { url: string; method: string; body: unknown } {
  const [url, init] = call as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

/** What both save hooks expose to these cases. */
type SaveHook = {
  mutateAsync: (input: { name: string; body: string }) => Promise<unknown>;
};

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('local skill save hooks', () => {
  test('create POSTs the input to /api/skills/local and resolves the whole envelope', async () => {
    const envelope = { success: true, data: { message: 'Created x' } };
    fetchMock.mockResolvedValue(jsonResponse(envelope));
    const { result } = renderHook(() => useCreateLocalSkillMutation(), {
      wrapper,
    });
    const input = {
      name: 'release-check',
      body: 'Ship {{ticket}}',
      command: { enabled: true, name: 'ship' },
    };

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync(input);
    });

    expect(resolved).toEqual(envelope);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(fetchMock.mock.calls[0])).toEqual({
      url: 'http://example.test/api/skills/local',
      method: 'POST',
      body: input,
    });
  });

  test('update PUTs the fields (not the name) to the encoded skill path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    const { result } = renderHook(() => useUpdateLocalSkillMutation(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({ name: 'a b/c#d', body: 'new body' });
    });

    // The old inline fetch interpolated the name raw, so `/`, `#` and a
    // space broke the route; the fetcher encodes it.
    expect(sent(fetchMock.mock.calls[0])).toEqual({
      url: 'http://example.test/api/skills/a%20b%2Fc%23d',
      method: 'PUT',
      body: { body: 'new body' },
    });
  });

  // Both hooks: an inline fetch reverted in either one throws a plain Error
  // with the reasons only, which is what this refuses.
  test.each([
    [
      'create',
      (): SaveHook => useCreateLocalSkillMutation(),
      { name: 'release-check', body: '' },
    ],
    [
      'update',
      (): SaveHook => useUpdateLocalSkillMutation(),
      { name: 'release-check', body: '' },
    ],
  ] as const)(
    'a refused %s rejects with the typed refusal, details included',
    async (_name, useHook, input) => {
      const details = {
        formErrors: [],
        fieldErrors: { body: ['String must contain at least 1 character(s)'] },
      };
      fetchMock.mockResolvedValue(
        jsonResponse(
          { success: false, error: 'Validation failed', details },
          400,
        ),
      );
      const { result } = renderHook(useHook, { wrapper });

      let failure: unknown;
      await act(async () => {
        failure = await (
          result.current.mutateAsync as (
            value: typeof input,
          ) => Promise<unknown>
        )(input).catch((caught: unknown) => caught);
      });

      expect(failure).toBeInstanceOf(StationHttpError);
      expect(failure).toMatchObject({ status: 400, details });
    },
  );
});
