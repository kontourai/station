import { beforeEach, describe, expect, test, vi } from 'vitest';

const { useApiQuery } = vi.hoisted(() => ({ useApiQuery: vi.fn() }));

vi.mock('../query-core', () => ({
  resolveApiBase: vi.fn(),
  useApiQuery,
}));

import { useAttentionQuery } from '../query-domains/attention';

describe('useAttentionQuery', () => {
  beforeEach(() => {
    useApiQuery.mockReset();
  });

  test('isolates cache identity by Station base and polls external changes', () => {
    useAttentionQuery('https://station-a.example');

    expect(useApiQuery).toHaveBeenCalledWith(
      ['attention', 'https://station-a.example'],
      expect.any(Function),
      { refetchInterval: 10_000 },
    );
  });

  test('allows callers to override the bounded polling interval', () => {
    useAttentionQuery('https://station-b.example', { refetchInterval: 2_000 });

    expect(useApiQuery).toHaveBeenCalledWith(
      ['attention', 'https://station-b.example'],
      expect.any(Function),
      { refetchInterval: 2_000 },
    );
  });
});
