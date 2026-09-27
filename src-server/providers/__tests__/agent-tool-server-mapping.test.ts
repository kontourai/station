import { describe, expect, test } from 'vitest';
import { toPassthroughToolDef } from '../adapters/agent-tool-server-mapping.js';

describe('toPassthroughToolDef (shared ResolvedAgentToolServer → ToolDef mapping)', () => {
  test('rebuilds a ToolDef from a ResolvedAgentToolServer, always kind mcp, never an env field', () => {
    expect(
      toPassthroughToolDef({
        id: 'weather',
        displayName: 'Weather',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'weather-mcp'],
        endpoint: undefined,
      }),
    ).toEqual({
      id: 'weather',
      kind: 'mcp',
      displayName: 'Weather',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'weather-mcp'],
      endpoint: undefined,
    });
  });
});
