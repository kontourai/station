/**
 * @vitest-environment jsdom
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentsLoaded } from '../contexts/AgentsContext';

const useAgentsQuery = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: (...args: unknown[]) => useAgentsQuery(...args),
}));

/**
 * `useAgentsLoaded` gates consumers that treat "the catalog answered" as a
 * license to make a definitive decision (`useChatDockActiveChatSync`'s #801
 * deleted-agent clear). It must report `true` only on an actual successful
 * resolution — not merely "not currently loading," which react-query also
 * clears on an ERRORED query (#945 round-2 MED finding: the first cut used
 * `!isLoading` and so read a network outage identically to a durably empty
 * catalog).
 */
describe('useAgentsLoaded', () => {
  // react-query keeps isLoading false during a background retry of a
  // still-errored query, so only isSuccess may license a decision.
  it.each([
    {
      state: 'still loading (no data yet)',
      query: {
        data: undefined,
        error: null,
        isLoading: true,
        isSuccess: false,
        isError: false,
      },
      loaded: false,
    },
    {
      state: 'errored, even though isLoading has cleared',
      query: {
        data: undefined,
        error: new Error('network unreachable'),
        isLoading: false,
        isSuccess: false,
        isError: true,
      },
      loaded: false,
    },
    {
      state: 'refetching in the background after a prior error',
      query: {
        data: undefined,
        error: new Error('network unreachable'),
        isLoading: false,
        isSuccess: false,
        isError: true,
        isFetching: true,
      },
      loaded: false,
    },
    {
      state: 'resolved successfully to an empty catalog',
      query: {
        data: [],
        error: null,
        isLoading: false,
        isSuccess: true,
        isError: false,
      },
      loaded: true,
    },
    {
      state: 'resolved successfully with agents',
      query: {
        data: [{ slug: 'claude', name: 'Claude Runtime' }],
        error: null,
        isLoading: false,
        isSuccess: true,
        isError: false,
      },
      loaded: true,
    },
  ])('is $loaded when the query is $state', ({ query, loaded }) => {
    useAgentsQuery.mockReturnValue(query);

    const { result } = renderHook(() => useAgentsLoaded());
    expect(result.current).toBe(loaded);
  });
});
