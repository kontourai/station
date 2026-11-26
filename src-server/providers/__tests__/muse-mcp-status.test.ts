import { describe, expect, test } from 'vitest';
import { museMcpStatusFromList } from '../adapters/muse-mcp-status.js';
import {
  MUSE_MCP_LIST_EMPTY_JSON,
  MUSE_MCP_LIST_JSON,
} from './muse-mcp-list-output.js';

describe('muse mcp list → engine-mcp.status', () => {
  test('names each configured server, enabled as configured (never ready), disabled as disabled', () => {
    expect(museMcpStatusFromList(MUSE_MCP_LIST_JSON)).toEqual([
      { name: 'http-one', state: 'configured', scope: 'engine-config' },
      { name: 'stdio-one', state: 'disabled', scope: 'engine-config' },
    ]);
  });

  test('carries nothing of an entry but its name and state', () => {
    const projected = JSON.stringify(museMcpStatusFromList(MUSE_MCP_LIST_JSON));
    for (const leaked of [
      'canary-arg-secret',
      'REDACTED',
      'mcp.example.test',
      'fake-server',
      'API_TOKEN',
      'authorization',
    ])
      expect(projected).not.toContain(leaked);
  });

  test('an empty list is a complete, empty answer; anything else is no answer', () => {
    expect(museMcpStatusFromList(MUSE_MCP_LIST_EMPTY_JSON)).toEqual([]);
    expect(museMcpStatusFromList('no MCP servers')).toBeUndefined();
    expect(museMcpStatusFromList('{"servers":{}}')).toBeUndefined();
  });

  test('a status this build has not seen, or one its enabled flag contradicts, is left out', () => {
    const servers = [
      { name: 'a', status: 'untrusted', enabled: false },
      { name: 'b', status: 'enabled', enabled: false },
      { name: 'bad‮name', status: 'enabled', enabled: true },
      { name: 'x'.repeat(129), status: 'enabled', enabled: true },
      { name: 'ok', status: 'enabled', enabled: true },
    ];
    expect(museMcpStatusFromList(JSON.stringify({ servers }))).toEqual([
      { name: 'ok', state: 'configured', scope: 'engine-config' },
    ]);
  });
});
