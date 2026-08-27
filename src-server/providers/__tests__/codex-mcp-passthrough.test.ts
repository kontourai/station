import type { ResolvedAgentToolServer } from '@kontourai/station-contracts/provider';
import { describe, expect, test } from 'vitest';
import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { resolveCodexMcpServers } from '../adapters/codex-mcp-passthrough.js';

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

describe('resolveCodexMcpServers', () => {
  test('maps a stdio tool server to -c mcp_servers.<id>.command/.args config args', () => {
    const result = resolveCodexMcpServers([toolServer()]);
    expect(result.skipped).toEqual([]);
    expect(result.deliveredIds).toEqual(['weather']);
    expect(result.configArgs).toEqual([
      '-c',
      'mcp_servers.weather.command="npx"',
      '-c',
      'mcp_servers.weather.args=["-y", "weather-mcp"]',
    ]);
  });

  test('a stdio server with no args omits the .args override', () => {
    const result = resolveCodexMcpServers([toolServer({ args: undefined })]);
    expect(result.configArgs).toEqual([
      '-c',
      'mcp_servers.weather.command="npx"',
    ]);
  });

  test('maps sse and streamable-http transports to a -c mcp_servers.<id>.url override', () => {
    const result = resolveCodexMcpServers([
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
    expect(result.deliveredIds).toEqual(['sse-server', 'http-server']);
    expect(result.configArgs).toEqual([
      '-c',
      'mcp_servers.sse-server.url="https://example.com/sse"',
      '-c',
      'mcp_servers.http-server.url="https://example.com/mcp"',
    ]);
  });

  test('skips a stdio server with no command as binary-not-found', () => {
    const result = resolveCodexMcpServers([
      toolServer({ command: undefined, args: undefined }),
    ]);
    expect(result.configArgs).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'weather', reason: 'binary-not-found' },
    ]);
  });

  test('skips an sse/http server with no endpoint as delivery-failed', () => {
    const result = resolveCodexMcpServers([
      toolServer({
        id: 'sse-server',
        transport: 'sse',
        command: undefined,
        args: undefined,
        endpoint: undefined,
      }),
    ]);
    expect(result.configArgs).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'sse-server',
        reason: 'delivery-failed',
        detail: 'no endpoint configured',
      },
    ]);
  });

  test('SECURITY: skips an id containing characters unsafe for a codex mcp_servers key path', () => {
    const result = resolveCodexMcpServers([
      toolServer({ id: 'weather"].evil="pwned' }),
    ]);
    expect(result.configArgs).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: 'weather"].evil="pwned',
        reason: 'delivery-failed',
        detail: 'tool-server id is not a safe codex mcp_servers key',
      },
    ]);
  });

  test('TOML-escapes a value containing a double quote or backslash', () => {
    const result = resolveCodexMcpServers([
      toolServer({
        id: 'weird',
        command: 'C:\\Program Files\\weird"tool.exe',
        args: undefined,
      }),
    ]);
    expect(result.configArgs).toEqual([
      '-c',
      String.raw`mcp_servers.weird.command="C:\\Program Files\\weird\"tool.exe"`,
    ]);
  });

  // station#1195 (Codex analog of #1157's station-control token-injection
  // boundary): the ONE behavioral difference from every other tool server
  // this module handles, and safe ONLY because the substitution is a
  // per-session URL+token (never env) — see this module's header comment.
  describe('station-control wire-safe url-token substitution', () => {
    test('substitutes a -c mcp_servers.station-control.url override for the built-in server, using the caller-provided URL', () => {
      const result = resolveCodexMcpServers(
        [
          toolServer({
            id: 'station-control',
            command: 'node',
            args: [builtinStationControlServerPath()],
          }),
        ],
        'http://127.0.0.1:3141/mcp/station-control?token=abc123',
      );
      expect(result.deliveredIds).toEqual(['station-control']);
      expect(result.configArgs).toEqual([
        '-c',
        'mcp_servers.station-control.url="http://127.0.0.1:3141/mcp/station-control?token=abc123"',
      ]);
    });

    test('skips the built-in server (delivery-failed) when no URL is provided, never falling back to the raw stdio command', () => {
      const result = resolveCodexMcpServers([
        toolServer({
          id: 'station-control',
          command: 'node',
          args: [builtinStationControlServerPath()],
        }),
      ]);
      expect(result.configArgs).toEqual([]);
      expect(result.skipped).toEqual([
        {
          id: 'station-control',
          reason: 'delivery-failed',
          detail: 'station-control MCP auth was not available for this session',
        },
      ]);
    });

    test('SECURITY: never substitutes the URL into a third-party server sharing the id "station-control" with a different command/args (spoof resistance)', () => {
      const result = resolveCodexMcpServers(
        [
          toolServer({
            id: 'station-control',
            command: 'node',
            args: ['/tmp/not-the-real-station-control.js'],
          }),
        ],
        'http://127.0.0.1:3141/mcp/station-control?token=abc123',
      );
      expect(result.configArgs).toEqual([
        '-c',
        'mcp_servers.station-control.command="node"',
        '-c',
        'mcp_servers.station-control.args=["/tmp/not-the-real-station-control.js"]',
      ]);
    });

    test('never substitutes the URL for a different server, even when a URL was provided for this session', () => {
      const result = resolveCodexMcpServers(
        [toolServer({ id: 'weather' })],
        'http://127.0.0.1:3141/mcp/station-control?token=abc123',
      );
      expect(result.configArgs).toEqual([
        '-c',
        'mcp_servers.weather.command="npx"',
        '-c',
        'mcp_servers.weather.args=["-y", "weather-mcp"]',
      ]);
    });
  });
});
