// @vitest-environment jsdom

/**
 * A relay chat's stats read went through the paired-Station tunnel, whose
 * ceiling has no agent-stats route, so the source Station answered 404 on
 * every message-count refresh. The real `useStats` runs here; the mock is one
 * layer lower, at the SDK query, so the assertions cover both what the hook
 * enables and the refetch it hands its callers (React Query's refetch ignores
 * `enabled`).
 */

import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationConnectionProvider } from '../../components/conversation/ConversationConnectionContext';
import type { StationConnection } from '../../connections/station-connection';
import { useStats } from '../StatsContext';

const refetch = vi.fn(async () => ({}));
const statsQueryConfig = vi.hoisted(() => [] as Array<{ enabled?: boolean }>);

vi.mock('@kontourai/station-sdk', () => ({
  useStatsQuery: (
    _agentSlug: string | undefined,
    _conversationId: string | undefined,
    config: { enabled?: boolean },
  ) => {
    statsQueryConfig.push(config);
    return { data: undefined, error: null, refetch, isLoading: false };
  },
}));

function wrapperFor(routeKind: StationConnection['routeKind']) {
  const station = {
    routeKind,
    targetApiBase: 'http://source.test/api/environments/peers/p/chat-api',
  } as StationConnection;
  return ({ children }: { children: ReactNode }) => (
    <ConversationConnectionProvider
      value={{ apiBase: station.targetApiBase, station }}
    >
      {children}
    </ConversationConnectionProvider>
  );
}

describe('useStats over a Station connection', () => {
  beforeEach(() => {
    refetch.mockClear();
    statsQueryConfig.length = 0;
  });

  test('a relay chat neither enables nor refetches the stats read', async () => {
    const { result } = renderHook(
      () => useStats('claude', 'claude:1', undefined, true),
      { wrapper: wrapperFor('relay') },
    );
    expect(statsQueryConfig.at(-1)?.enabled).toBe(false);
    await result.current.refetch();
    expect(refetch).not.toHaveBeenCalled();
  });

  test('a direct chat still reads and refetches its stats', async () => {
    const { result } = renderHook(
      () => useStats('claude', 'claude:1', undefined, true),
      { wrapper: wrapperFor('direct') },
    );
    expect(statsQueryConfig.at(-1)?.enabled).toBe(true);
    await result.current.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
