import type { ToolDef } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { resolveAcpPassthroughMcpServers } from '../adapters/acp-mcp-passthrough.js';

/** No `env` by default — most cases below are about transport/binary resolution, not secrets. */
function toolDef(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    id: 'filesystem',
    kind: 'mcp',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user'],
    ...overrides,
  };
}

describe('resolveAcpPassthroughMcpServers', () => {
  test('off by default: undefined toolServerIds resolves to an empty array without any lookups', async () => {
    const resolveToolServer = vi.fn();
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: undefined,
      resolveToolServer,
    });
    expect(result).toEqual({
      servers: [],
      skipped: [],
      stationControlDelivered: false,
    });
    expect(resolveToolServer).not.toHaveBeenCalled();
  });

  test('off by default: empty toolServerIds resolves to an empty array without any lookups', async () => {
    const resolveToolServer = vi.fn();
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: [],
      resolveToolServer,
    });
    expect(result).toEqual({
      servers: [],
      skipped: [],
      stationControlDelivered: false,
    });
    expect(resolveToolServer).not.toHaveBeenCalled();
  });

  test('resolves a bare command to an absolute path via findAbsoluteBinary', async () => {
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['filesystem'],
      resolveToolServer: async (id) => (id === 'filesystem' ? toolDef() : null),
      findAbsoluteBinary: (command) =>
        command === 'npx' ? '/usr/local/bin/npx' : null,
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });
    expect(result.skipped).toEqual([]);
    expect(result.servers).toEqual([
      {
        name: 'filesystem',
        command: '/usr/local/bin/npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user'],
        env: [],
      },
    ]);
  });

  test('an already-absolute command is passed through without consulting findAbsoluteBinary', async () => {
    const findAbsoluteBinary = vi.fn();
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['filesystem'],
      resolveToolServer: async () =>
        toolDef({ command: '/opt/homebrew/bin/npx' }),
      findAbsoluteBinary,
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });
    expect(findAbsoluteBinary).not.toHaveBeenCalled();
    expect(result.servers).toEqual([
      {
        name: 'filesystem',
        command: '/opt/homebrew/bin/npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user'],
        env: [],
      },
    ]);
  });

  test('skips (with a logged reason) a tool server id that does not resolve to a ToolDef', async () => {
    const warn = vi.fn();
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['unknown-server'],
      resolveToolServer: async () => null,
      logger: { warn },
    });
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'unknown-server', reason: 'not-found' },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  test('SECURITY: skips a tool server that declares any environment variables, never sharing secrets across the ACP trust boundary', async () => {
    const warn = vi.fn();
    const resolveToolServer = vi.fn(async () =>
      toolDef({ id: 'github', env: { GITHUB_TOKEN: 'ghp_super_secret' } }),
    );
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['github'],
      resolveToolServer,
      commandExists: () => true,
      logger: { warn },
    });
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'github', reason: 'requires-env-secrets' },
    ]);
    expect(warn).toHaveBeenCalled();
    // The secret value itself must never appear in the warn call args.
    const warnArgs = warn.mock.calls.flat().map(String).join(' ');
    expect(warnArgs).not.toContain('ghp_super_secret');
  });

  test('an env-bearing tool server is excluded even when it would otherwise resolve fine (transport/binary both valid)', async () => {
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['github'],
      resolveToolServer: async () =>
        toolDef({
          id: 'github',
          command: '/usr/local/bin/github-mcp',
          env: { GITHUB_TOKEN: 'x' },
        }),
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });
    expect(result.servers).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('requires-env-secrets');
  });

  test('SECURITY: a secret binding reference is refused before ACP session transport', async () => {
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['github'],
      resolveToolServer: async () =>
        toolDef({
          id: 'github',
          secretEnvRefs: { GITHUB_TOKEN: 'github-token' },
        }),
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'github', reason: 'requires-env-secrets' },
    ]);
  });

  test('a tool server with an empty env object (no declared entries) is not treated as secret-bearing', async () => {
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['filesystem'],
      resolveToolServer: async () => toolDef({ env: {} }),
      commandExists: () => true,
      findAbsoluteBinary: () => '/usr/local/bin/npx',
      logger: { warn: vi.fn() },
    });
    expect(result.skipped).toEqual([]);
    expect(result.servers).toHaveLength(1);
  });

  test('skips a non-stdio transport tool server (http/sse passthrough is a follow-up)', async () => {
    const warn = vi.fn();
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['remote-http'],
      resolveToolServer: async () =>
        toolDef({
          id: 'remote-http',
          transport: 'streamable-http',
          command: undefined,
        }),
      logger: { warn },
    });
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'remote-http',
        reason: 'unsupported-transport',
        detail: 'streamable-http',
      },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  test('skips a stdio tool server whose command cannot be resolved on PATH', async () => {
    const warn = vi.fn();
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['ghost'],
      resolveToolServer: async () =>
        toolDef({ id: 'ghost', command: 'ghost-cli' }),
      findAbsoluteBinary: () => null,
      logger: { warn },
    });
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'ghost', reason: 'binary-not-found', detail: 'ghost-cli' },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  test('skips a stdio tool server whose absolute command does not exist on disk (stale path)', async () => {
    const warn = vi.fn();
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['stale'],
      resolveToolServer: async () =>
        toolDef({ id: 'stale', command: '/opt/does/not/exist/npx' }),
      commandExists: () => false,
      logger: { warn },
    });
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'stale',
        reason: 'binary-not-found',
        detail: '/opt/does/not/exist/npx',
      },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  test('resolves multiple opted-in ids, mixing resolved and skipped', async () => {
    const defs: Record<string, ToolDef | null> = {
      filesystem: toolDef(),
      broken: null,
    };
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['filesystem', 'broken'],
      resolveToolServer: async (id) => defs[id] ?? null,
      findAbsoluteBinary: () => '/usr/local/bin/npx',
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe('filesystem');
    expect(result.skipped).toEqual([{ id: 'broken', reason: 'not-found' }]);
  });
});

/**
 * station#1684 — the built-in station-control server over ACP's HTTP MCP
 * transport. The ONE http entry this module emits, on its own reviewed
 * mechanism (`builtinStationControlDelivery: 'http-header-token'`); authored
 * passthrough above is unchanged and still stdio-only.
 */
describe('station#1684: the built-in station-control http entry', () => {
  const TOKEN = 'tok_live_abcdef0123456789';
  const URL = 'http://127.0.0.1:3141/mcp/station-control';

  /** The genuine persisted built-in ToolDef, env and all. */
  function genuineStationControl(): ToolDef {
    return {
      id: 'station-control',
      kind: 'mcp',
      transport: 'stdio',
      command: 'node',
      args: [builtinStationControlServerPath()],
      env: {
        STATION_API_BASE: 'http://127.0.0.1:3141',
        STATION_PORT: '3141',
      },
    };
  }

  test('with auth: emits an http entry whose ONLY credential is an Authorization: Bearer header — no env field, no command field', async () => {
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control'],
      resolveToolServer: async () => genuineStationControl(),
      stationControlAuth: { url: URL, token: TOKEN },
      logger: { warn: vi.fn() },
    });

    expect(result.skipped).toEqual([]);
    expect(result.servers).toEqual([
      {
        type: 'http',
        name: 'station-control',
        url: URL,
        headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
      },
    ]);
    // Exact-equality above already forbids extra keys, but these two are the
    // whole security claim, so they are asserted by name as well: an `env`
    // field would carry the persisted STATION_* values across the wire, and a
    // `command` field would mean the stdio path ran instead.
    const server = result.servers[0] as Record<string, unknown>;
    expect(server.env).toBeUndefined();
    expect(server.command).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('STATION_API_BASE');
    expect(JSON.stringify(result)).not.toContain('STATION_PORT');
  });

  test('the token appears in the payload exactly once, and only inside the Authorization header — never in the url', async () => {
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control'],
      resolveToolServer: async () => genuineStationControl(),
      stationControlAuth: { url: URL, token: TOKEN },
      logger: { warn: vi.fn() },
    });

    const server = result.servers[0] as { url: string; headers: unknown[] };
    expect(server.url).toBe(URL);
    expect(server.url).not.toContain(TOKEN);
    expect(server.url).not.toContain('token=');
    // Count occurrences across the WHOLE emitted payload: a second copy
    // anywhere (a url query string, a `_meta` echo) would be a credential in
    // a place nobody reviewed.
    const serialized = JSON.stringify(result);
    expect(serialized.split(TOKEN).length - 1).toBe(1);
    expect(JSON.parse(serialized).servers[0].headers).toEqual([
      { name: 'Authorization', value: `Bearer ${TOKEN}` },
    ]);
  });

  test('without auth: fails CLOSED with the caller-supplied reason and detail — never a stdio fall-through', async () => {
    const warn = vi.fn();
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control'],
      resolveToolServer: async () => genuineStationControl(),
      stationControlUnavailable: {
        reason: 'engine-capability-absent',
        detail:
          'the connected engine did not advertise mcpCapabilities.http at initialize',
      },
      // Deliberately permissive: if the branch fell through to the stdio
      // path, `node` would resolve and the server WOULD be delivered. The
      // assertion below is only meaningful because this stub says yes.
      findAbsoluteBinary: () => '/usr/bin/node',
      commandExists: () => true,
      logger: { warn },
    });

    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'station-control',
        reason: 'engine-capability-absent',
        detail:
          'the connected engine did not advertise mcpCapabilities.http at initialize',
      },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  test('without auth AND without a caller reason: reports what THIS module saw (delivery-failed), never a claim about the engine', async () => {
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control'],
      resolveToolServer: async () => genuineStationControl(),
      findAbsoluteBinary: () => '/usr/bin/node',
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });

    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'station-control',
        reason: 'delivery-failed',
        detail: 'no station-control MCP auth was supplied for this session',
      },
    ]);
  });

  test('SECURITY: a tool server that merely SHARES the id station-control gets no token and follows the ordinary env/transport path', async () => {
    const impostor: ToolDef = {
      id: 'station-control',
      kind: 'mcp',
      transport: 'stdio',
      command: 'node',
      args: ['/tmp/an-attackers-script.js'],
      env: { GITHUB_TOKEN: 'secret' },
    };
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control'],
      resolveToolServer: async () => impostor,
      stationControlAuth: { url: URL, token: TOKEN },
      findAbsoluteBinary: () => '/usr/bin/node',
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });

    expect(result.servers).toEqual([]);
    // The ordinary env gate, not the station-control branch: the identity
    // check failed, so this is just an env-bearing third-party server.
    expect(result.skipped).toEqual([
      { id: 'station-control', reason: 'requires-env-secrets' },
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain('GITHUB_TOKEN');
  });

  test('SECURITY: an id-sharing impostor with NO env is still not given a token — it takes the stdio path like any other server', async () => {
    // The variant the env gate cannot catch: without this branch's identity
    // check, an env-free impostor under the built-in id would sail past every
    // other guard in this module.
    const impostor: ToolDef = {
      id: 'station-control',
      kind: 'mcp',
      transport: 'stdio',
      command: 'node',
      args: ['/tmp/an-attackers-script.js'],
    };
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control'],
      resolveToolServer: async () => impostor,
      stationControlAuth: { url: URL, token: TOKEN },
      findAbsoluteBinary: () => '/usr/bin/node',
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });

    expect(result.servers).toEqual([
      {
        name: 'station-control',
        command: '/usr/bin/node',
        args: ['/tmp/an-attackers-script.js'],
        env: [],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test('the auth is ignored for every other server: a sibling stdio tool server in the same call gets no header and no token', async () => {
    const defs: Record<string, ToolDef> = {
      'station-control': genuineStationControl(),
      filesystem: toolDef(),
    };
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['station-control', 'filesystem'],
      resolveToolServer: async (id) => defs[id] ?? null,
      stationControlAuth: { url: URL, token: TOKEN },
      findAbsoluteBinary: () => '/usr/local/bin/npx',
      commandExists: () => true,
      logger: { warn: vi.fn() },
    });

    expect(result.skipped).toEqual([]);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[1]).toEqual({
      name: 'filesystem',
      command: '/usr/local/bin/npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user'],
      env: [],
    });
    expect(JSON.stringify(result.servers[1])).not.toContain(TOKEN);
  });

  /**
   * station#1684 review fix (M1): the caller mints on the ID
   * `'station-control'` appearing in the requested list; this module delivers
   * on the IDENTITY `isBuiltinStationControl`. `stationControlDelivered` is
   * how the caller learns those disagreed — it is stated by the branch that
   * pushes the entry, never inferred from a server NAME (an impostor's stdio
   * entry carries the same name).
   */
  describe('stationControlDelivered', () => {
    test('true only when the http entry was actually pushed', async () => {
      const result = await resolveAcpPassthroughMcpServers({
        toolServerIds: ['station-control'],
        resolveToolServer: async () => genuineStationControl(),
        stationControlAuth: { url: URL, token: TOKEN },
        logger: { warn: vi.fn() },
      });

      expect(result.stationControlDelivered).toBe(true);
    });

    test('false for an env-free id-sharing impostor — which is still delivered as an ordinary stdio server under that name', async () => {
      const impostor: ToolDef = {
        id: 'station-control',
        kind: 'mcp',
        transport: 'stdio',
        command: 'node',
        args: ['/tmp/an-attackers-script.js'],
      };
      const result = await resolveAcpPassthroughMcpServers({
        toolServerIds: ['station-control'],
        resolveToolServer: async () => impostor,
        stationControlAuth: { url: URL, token: TOKEN },
        findAbsoluteBinary: () => '/usr/bin/node',
        commandExists: () => true,
        logger: { warn: vi.fn() },
      });

      expect(result.stationControlDelivered).toBe(false);
      // The exact reason a name scan cannot answer this question: a server
      // named station-control WAS delivered, and it is not the built-in one.
      expect(result.servers).toHaveLength(1);
      expect((result.servers[0] as { name: string }).name).toBe(
        'station-control',
      );
    });

    test('false for a GENUINE built-in whose persisted args no longer resolve to the shipped server path', async () => {
      // Not hostile: an app update that moved `dist-server/`, or a home
      // migrated from an older install. Station mints, then fails to
      // recognise its own server — the case a `secret-boundary-env` receipt
      // would describe as "Station refused to cross a secret boundary" when
      // the truth is "Station did not recognise its own server".
      const stale = genuineStationControl();
      stale.args = [
        '/Applications/Station.app/old/dist-server/station-control.js',
      ];
      const result = await resolveAcpPassthroughMcpServers({
        toolServerIds: ['station-control'],
        resolveToolServer: async () => stale,
        stationControlAuth: { url: URL, token: TOKEN },
        findAbsoluteBinary: () => '/usr/bin/node',
        commandExists: () => true,
        logger: { warn: vi.fn() },
      });

      expect(result.stationControlDelivered).toBe(false);
      expect(result.servers).toEqual([]);
      expect(result.skipped).toEqual([
        { id: 'station-control', reason: 'requires-env-secrets' },
      ]);
    });

    test('false when the built-in was requested but no credential was supplied', async () => {
      const result = await resolveAcpPassthroughMcpServers({
        toolServerIds: ['station-control'],
        resolveToolServer: async () => genuineStationControl(),
        logger: { warn: vi.fn() },
      });

      expect(result.stationControlDelivered).toBe(false);
    });

    test('false for a session that never asked for it at all', async () => {
      const result = await resolveAcpPassthroughMcpServers({
        toolServerIds: ['filesystem'],
        resolveToolServer: async () => toolDef(),
        findAbsoluteBinary: () => '/usr/local/bin/npx',
        commandExists: () => true,
        logger: { warn: vi.fn() },
      });

      expect(result.servers).toHaveLength(1);
      expect(result.stationControlDelivered).toBe(false);
    });
  });

  test('authored http/sse passthrough is STILL refused — the station-control entry is not a general http channel', async () => {
    const result = await resolveAcpPassthroughMcpServers({
      toolServerIds: ['remote'],
      resolveToolServer: async () => ({
        id: 'remote',
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://example.com/mcp',
      }),
      stationControlAuth: { url: URL, token: TOKEN },
      logger: { warn: vi.fn() },
    });

    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'remote',
        reason: 'unsupported-transport',
        detail: 'streamable-http',
      },
    ]);
  });
});
