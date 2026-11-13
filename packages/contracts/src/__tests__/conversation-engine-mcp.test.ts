import { describe, expect, test } from 'vitest';
import {
  type ConversationEngineMcpStatus,
  foldEngineMcpStatus,
  parseConversationStatsResponse,
} from '../runtime.js';
import {
  ENGINE_MCP_ERROR_MAX_CHARS,
  ENGINE_MCP_SERVER_NAME_MAX_CHARS,
  ENGINE_MCP_STATUS_MAX_SERVERS,
} from '../runtime-events.js';

const ready = { name: 'a', state: 'ready', scope: 'session' } as const;
const failed = {
  name: 'b',
  state: 'failed',
  error: 'x',
  scope: 'engine-config',
} as const;

describe('foldEngineMcpStatus', () => {
  test('a complete report replaces the list', () => {
    const current: ConversationEngineMcpStatus = { servers: [ready] };
    expect(
      foldEngineMcpStatus(current, { servers: [failed], complete: true }),
    ).toEqual({ servers: [failed] });
  });

  test('a partial report updates named servers in place and appends new ones', () => {
    const current = foldEngineMcpStatus(undefined, {
      servers: [ready, failed],
      complete: true,
    });
    expect(
      foldEngineMcpStatus(current, {
        servers: [
          { name: 'b', state: 'ready', scope: 'engine-config', toolCount: 2 },
          { name: 'c', state: 'starting', scope: 'engine-config' },
        ],
        complete: false,
      }).servers.map(({ name, state }) => `${name}:${state}`),
    ).toEqual(['a:ready', 'b:ready', 'c:starting']);
  });

  test('the reconnect bit is the latest report’s', () => {
    const on = foldEngineMcpStatus(undefined, {
      servers: [ready],
      complete: true,
      reconnect: true,
    });
    expect(on.reconnect).toBe(true);
    const off = foldEngineMcpStatus(on, { servers: [failed], complete: false });
    expect(off).not.toHaveProperty('reconnect');
    // Only the literal `true` turns it on.
    expect(
      foldEngineMcpStatus(undefined, { servers: [], reconnect: 'yes' }),
    ).not.toHaveProperty('reconnect');
  });

  test('drops a malformed or out-of-bounds server and bounds the list', () => {
    expect(
      foldEngineMcpStatus(undefined, {
        servers: [
          { name: 'x', state: 'exploded', scope: 'session' },
          null,
          'a',
          { ...ready, name: 'n'.repeat(ENGINE_MCP_SERVER_NAME_MAX_CHARS + 1) },
          { ...failed, error: 'e'.repeat(ENGINE_MCP_ERROR_MAX_CHARS + 1) },
          { ...ready, toolCount: -1 },
        ],
        complete: true,
      }).servers,
    ).toEqual([]);
    // The passive sign-in link is not kept.
    expect(
      foldEngineMcpStatus(undefined, {
        servers: [{ ...ready, authUrl: 'https://example.test/a' }],
      }).servers,
    ).toEqual([ready]);
    expect(ENGINE_MCP_STATUS_MAX_SERVERS).toBe(64);
    const many = Array.from(
      { length: ENGINE_MCP_STATUS_MAX_SERVERS + 5 },
      (_, i) => ({ name: `s${i}`, state: 'ready', scope: 'session' }),
    );
    expect(
      foldEngineMcpStatus(undefined, { servers: many, complete: true }).servers,
    ).toHaveLength(64);
    // A partial report does not grow a full list past the bound either.
    const full = foldEngineMcpStatus(undefined, {
      servers: many,
      complete: true,
    });
    expect(
      foldEngineMcpStatus(full, {
        servers: [{ name: 'late', state: 'ready', scope: 'session' }],
      }).servers.map(({ name }) => name),
    ).not.toContain('late');
  });
});

describe('parseConversationStatsResponse engineMcp', () => {
  const base = { modelId: 'm', turns: 0, toolCalls: 0 };

  test('carries a well-formed folded status', () => {
    const engineMcp = {
      servers: [{ ...ready, toolCount: 3 }, failed],
      reconnect: true,
    };
    expect(
      parseConversationStatsResponse({ ...base, engineMcp })?.engineMcp,
    ).toEqual(engineMcp);
    expect(parseConversationStatsResponse(base)).not.toHaveProperty(
      'engineMcp',
    );
  });

  test('keeps the first 64 servers rather than refusing the response', () => {
    const servers = Array.from({ length: 65 }, (_, i) => ({
      name: `s${i}`,
      state: 'ready',
      scope: 'session',
    }));
    const parsed = parseConversationStatsResponse({
      ...base,
      engineMcp: { servers },
    });
    expect(parsed?.engineMcp?.servers).toHaveLength(64);
    expect(parsed?.engineMcp?.servers.at(-1)?.name).toBe('s63');
  });

  test.each([
    ['not an object', 'servers'],
    ['servers not a list', { servers: {} }],
    ['reconnect not true', { servers: [], reconnect: false }],
  ])('refuses an engineMcp of the wrong shape (%s)', (_label, engineMcp) => {
    expect(
      parseConversationStatsResponse({ ...base, engineMcp }),
    ).toBeUndefined();
  });

  test.each([
    ['unknown state', { ...ready, state: 'exploded' }],
    ['unknown scope', { ...ready, scope: 'global' }],
    ['empty name', { ...ready, name: '' }],
    ['name past the bound', { ...ready, name: 'n'.repeat(129) }],
    ['error past the bound', { ...failed, error: 'e'.repeat(513) }],
    ['negative tool count', { ...ready, toolCount: -1 }],
    ['fractional tool count', { ...ready, toolCount: 1.5 }],
  ])(
    'drops one bad server (%s) and keeps the rest and the response',
    (_label, bad) => {
      const parsed = parseConversationStatsResponse({
        ...base,
        engineMcp: { servers: [bad, failed], reconnect: true },
      });
      expect(parsed?.turns).toBe(0);
      expect(parsed?.engineMcp).toEqual({ servers: [failed], reconnect: true });
    },
  );

  test('the bound counts the servers kept, not the entries sent', () => {
    const servers = [
      { ...ready, state: 'exploded' },
      ...Array.from({ length: 64 }, (_, i) => ({ ...ready, name: `s${i}` })),
    ];
    const parsed = parseConversationStatsResponse({
      ...base,
      engineMcp: { servers },
    });
    expect(parsed?.engineMcp?.servers).toHaveLength(64);
    expect(parsed?.engineMcp?.servers.at(-1)?.name).toBe('s63');
  });

  test('accepts a name and an error exactly at their bounds', () => {
    const server = {
      ...failed,
      name: 'n'.repeat(ENGINE_MCP_SERVER_NAME_MAX_CHARS),
      error: 'e'.repeat(ENGINE_MCP_ERROR_MAX_CHARS),
    };
    expect(
      parseConversationStatsResponse({
        ...base,
        engineMcp: { servers: [server] },
      })?.engineMcp?.servers,
    ).toEqual([server]);
  });
});
