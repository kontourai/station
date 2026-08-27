import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import { describe, expect, test } from 'vitest';
import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { INTERNAL_API_TOKEN_ENV } from '../../utils/internal-api-token.js';
import { resolveClaudeMcpServers } from '../adapters/claude-mcp-passthrough.js';

function toolServer(
  overrides: Partial<ResolvedAgentToolServer> = {},
): ResolvedAgentToolServer {
  return {
    id: 'weather',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'weather-mcp'],
    ...overrides,
  };
}

describe('resolveClaudeMcpServers', () => {
  test('maps a stdio tool server to an SDK stdio McpServerConfig with no env by default', () => {
    const result = resolveClaudeMcpServers([toolServer()]);
    expect(result.skipped).toEqual([]);
    expect(result.servers).toEqual({
      weather: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'weather-mcp'],
      },
    });
  });

  test('maps sse and streamable-http transports to their SDK equivalents', () => {
    const result = resolveClaudeMcpServers([
      toolServer({
        id: 'sse-server',
        transport: 'sse',
        command: undefined,
        args: undefined,
        endpoint: 'https://example.com/sse',
      }),
      toolServer({
        id: 'http-server',
        transport: 'streamable-http',
        command: undefined,
        args: undefined,
        endpoint: 'https://example.com/mcp',
      }),
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.servers).toEqual({
      'sse-server': { type: 'sse', url: 'https://example.com/sse' },
      'http-server': { type: 'http', url: 'https://example.com/mcp' },
    });
  });

  test('skips a stdio server with no command as binary-not-found', () => {
    const result = resolveClaudeMcpServers([
      toolServer({ command: undefined, args: undefined }),
    ]);
    expect(result.servers).toEqual({});
    expect(result.skipped).toEqual([
      { id: 'weather', reason: 'binary-not-found' },
    ]);
  });

  test('skips an sse/http server with no endpoint as delivery-failed', () => {
    const result = resolveClaudeMcpServers([
      toolServer({
        id: 'sse-server',
        transport: 'sse',
        command: undefined,
        args: undefined,
        endpoint: undefined,
      }),
    ]);
    expect(result.servers).toEqual({});
    expect(result.skipped).toEqual([
      {
        id: 'sse-server',
        reason: 'delivery-failed',
        detail: 'no endpoint configured',
      },
    ]);
  });

  // Station#1157 security boundary: this is the one behavioral difference
  // from ACP's equivalent (acp-mcp-passthrough.ts), and it is safe ONLY
  // because the Claude Agent SDK spawns this server in Station's own
  // subprocess — see claude-mcp-passthrough.ts's header comment.
  describe('station-control runtime token injection', () => {
    test('injects the Station internal API token into the built-in station-control server', () => {
      const result = resolveClaudeMcpServers([
        toolServer({
          id: 'station-control',
          command: 'node',
          args: [builtinStationControlServerPath()],
        }),
      ]);
      expect(result.servers['station-control']).toEqual({
        type: 'stdio',
        command: 'node',
        args: [builtinStationControlServerPath()],
        env: { [INTERNAL_API_TOKEN_ENV]: expect.any(String) },
      });
    });

    test('never injects the token into a third-party server, even one sharing the id "station-control" with a different command/args (spoof resistance)', () => {
      const result = resolveClaudeMcpServers([
        toolServer({
          id: 'station-control',
          command: 'node',
          args: ['/tmp/not-the-real-station-control.js'],
        }),
      ]);
      expect(result.servers['station-control']).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['/tmp/not-the-real-station-control.js'],
      });
      expect('env' in result.servers['station-control']).toBe(false);
    });

    test('never injects the token into an env-less third-party server', () => {
      const result = resolveClaudeMcpServers([toolServer({ id: 'weather' })]);
      expect('env' in result.servers.weather).toBe(false);
    });
  });
});
