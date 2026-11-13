import { describe, expect, test, vi } from 'vitest';

// The handler module reaches the chat store, which reads storage on import.
vi.hoisted(() => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});

import {
  CHAT_ENGINE_MCP_SERVERS_MAX,
  foldEngineMcpServers,
} from '../engineMcpHandlers';

describe('foldEngineMcpServers', () => {
  const ready = { name: 'a', state: 'ready', scope: 'session' };
  const failed = {
    name: 'b',
    state: 'failed',
    error: 'x',
    scope: 'engine-config',
  };

  test('a complete report replaces the list', () => {
    expect(foldEngineMcpServers([ready as never], [failed], true)).toEqual([
      failed,
    ]);
  });

  test('a partial report updates named servers in place and appends new ones', () => {
    const current = foldEngineMcpServers(undefined, [ready, failed], true);
    expect(
      foldEngineMcpServers(
        current,
        [
          { name: 'b', state: 'ready', scope: 'engine-config', toolCount: 2 },
          { name: 'c', state: 'starting', scope: 'engine-config' },
        ],
        false,
      ).map(({ name, state }) => `${name}:${state}`),
    ).toEqual(['a:ready', 'b:ready', 'c:starting']);
  });

  test('drops a malformed server and bounds the list', () => {
    expect(
      foldEngineMcpServers(
        undefined,
        [{ name: 'x', state: 'exploded', scope: 'session' }, null, 'a'],
        true,
      ),
    ).toEqual([]);
    const many = Array.from(
      { length: CHAT_ENGINE_MCP_SERVERS_MAX + 5 },
      (_, i) => ({
        name: `s${i}`,
        state: 'ready',
        scope: 'session',
      }),
    );
    expect(foldEngineMcpServers(undefined, many, true)).toHaveLength(
      CHAT_ENGINE_MCP_SERVERS_MAX,
    );
  });
});
