import { describe, expect, test, vi } from 'vitest';
import {
  getNormalizedToolName,
  getOriginalToolName,
  matchesToolPattern,
  normalizeLoadedMCPTools,
} from '../mcp-tool-names.js';

describe('mcp-tool-names', () => {
  test('normalizeLoadedMCPTools stores normalized mappings', () => {
    const toolNameMapping = new Map();
    const toolNameReverseMapping = new Map();
    const logger = { debug: vi.fn() };

    const normalizedTools = normalizeLoadedMCPTools(
      'agent-a',
      [{ name: 'my-server_tool_name', execute: vi.fn() }] as any,
      toolNameMapping,
      toolNameReverseMapping,
      logger,
    );

    expect(normalizedTools).toEqual([
      expect.objectContaining({ name: 'myServer_toolName' }),
    ]);
    expect(toolNameMapping.get('myServer_toolName')).toEqual({
      original: 'my-server_tool_name',
      normalized: 'myServer_toolName',
      server: 'my-server',
      tool: 'tool_name',
    });
    expect(toolNameReverseMapping.get('my-server_tool_name')).toBe(
      'myServer_toolName',
    );
    expect(logger.debug).toHaveBeenCalled();
  });

  test('matchesToolPattern supports normalized and legacy wildcard patterns', () => {
    const toolNameMapping = new Map([
      [
        'server_tool',
        {
          original: 'server/tool',
          normalized: 'server_tool',
          server: 'server',
          tool: 'tool',
        },
      ],
    ]);

    expect(
      matchesToolPattern('server_tool', ['server_tool'], toolNameMapping),
    ).toBe(true);
    expect(
      matchesToolPattern('server_tool', ['server_*'], toolNameMapping),
    ).toBe(true);
    expect(
      matchesToolPattern('server_tool', ['server/*'], toolNameMapping),
    ).toBe(true);
    expect(
      matchesToolPattern('server_tool', ['other_*'], toolNameMapping),
    ).toBe(false);
  });

  test('getOriginalToolName and getNormalizedToolName fall back cleanly', () => {
    const toolNameMapping = new Map([
      [
        'server_tool',
        {
          original: 'server/tool',
          normalized: 'server_tool',
          server: 'server',
          tool: 'tool',
        },
      ],
    ]);
    const toolNameReverseMapping = new Map([['server/tool', 'server_tool']]);

    expect(getOriginalToolName('server_tool', toolNameMapping)).toBe(
      'server/tool',
    );
    expect(getOriginalToolName('plain_tool', toolNameMapping)).toBe(
      'plain_tool',
    );
    expect(getNormalizedToolName('server/tool', toolNameReverseMapping)).toBe(
      'server_tool',
    );
    expect(getNormalizedToolName('plain_tool', toolNameReverseMapping)).toBe(
      'plain_tool',
    );
  });
});
