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
 * `useAgentsLoaded()` gates consumers that treat "the catalog answered" as a
 * license to make a definitive decision (`useChatDockActiveChatSync`'s #801
 * deleted-agent clear). It must report `true` only on an actual successful
 * resolution — not merely "not currently loading," which react-query also
 * clears on an ERRORED query (#945 round-2 MED finding: the first cut used
 * `!isLoading` and so read a network outage identically to a durably empty
 * catalog).
 */
describe('useAgentsLoaded', () => {
  it('is false while the query is still loading (no data yet)', () => {
    useAgentsQuery.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
      isSuccess: false,
      isError: false,
    });

    const { result } = renderHook(() => useAgentsLoaded());
    expect(result.current).toBe(false);
  });

  it('is false when the query has errored, even though isLoading has cleared', () => {
    useAgentsQuery.mockReturnValue({
      data: undefined,
      error: new Error('network unreachable'),
      isLoading: false,
      isSuccess: false,
      isError: true,
    });

    const { result } = renderHook(() => useAgentsLoaded());
    expect(result.current).toBe(false);
  });

  it('is false while a background refetch is in flight after a prior error', () => {
    // react-query keeps isLoading false and isSuccess false during a
    // background retry of a still-errored query.
    useAgentsQuery.mockReturnValue({
      data: undefined,
      error: new Error('network unreachable'),
      isLoading: false,
      isSuccess: false,
      isError: true,
      isFetching: true,
    });

    const { result } = renderHook(() => useAgentsLoaded());
    expect(result.current).toBe(false);
  });

  it('is true once the query resolves successfully, even to an empty catalog', () => {
    useAgentsQuery.mockReturnValue({
      data: [],
      error: null,
      isLoading: false,
      isSuccess: true,
      isError: false,
    });

    const { result } = renderHook(() => useAgentsLoaded());
    expect(result.current).toBe(true);
  });

  it('is true once the query resolves successfully with agents', () => {
    useAgentsQuery.mockReturnValue({
      data: [{ slug: 'claude', name: 'Claude Runtime' }],
      error: null,
      isLoading: false,
      isSuccess: true,
      isError: false,
    });

    const { result } = renderHook(() => useAgentsLoaded());
    expect(result.current).toBe(true);
  });
});
