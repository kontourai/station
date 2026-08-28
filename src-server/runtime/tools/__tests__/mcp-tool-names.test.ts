import { describe, expect, test, vi } from 'vitest';
import {
  createMCPToolProvenanceGeneration,
  isCurrentMCPToolLoaderProvenance,
} from '../../../services/orchestration/mcp-tool-provenance.js';
import {
  getLoadedMCPToolProvenance,
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
    const generation = createMCPToolProvenanceGeneration();

    const normalizedTools = normalizeLoadedMCPTools(
      'agent-a',
      [{ name: 'my-server_tool_name', execute: vi.fn() }] as any,
      toolNameMapping,
      toolNameReverseMapping,
      generation,
      'github-integration',
      () => ({ serverId: 'github', originalToolName: 'create_issue' }),
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
      provenance: expect.objectContaining({
        serverId: 'github',
        originalToolName: 'create_issue',
        runtimeName: 'myServer_toolName',
        integrationId: 'github-integration',
      }),
    });
    expect(toolNameReverseMapping.get('my-server_tool_name')).toBe(
      'myServer_toolName',
    );
    expect(logger.debug).toHaveBeenCalled();
    expect(getLoadedMCPToolProvenance(normalizedTools[0])).toBe(
      toolNameMapping.get('myServer_toolName')?.provenance,
    );
  });

  test('records unchanged names and revokes the issued authority with its generation', () => {
    const mapping = new Map();
    const reverse = new Map();
    const generation = createMCPToolProvenanceGeneration();
    const [loaded] = normalizeLoadedMCPTools(
      'agent-a',
      [{ name: 'github_create_issue', execute: vi.fn() }] as any,
      mapping,
      reverse,
      generation,
      'github-integration',
      () => ({ serverId: 'github', originalToolName: 'create_issue' }),
      { debug: vi.fn() },
    );

    const provenance = getLoadedMCPToolProvenance(loaded);
    expect(mapping.get('github_createIssue')).toEqual(
      expect.objectContaining({ provenance }),
    );
    expect(reverse.get('github_create_issue')).toBe('github_createIssue');
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(isCurrentMCPToolLoaderProvenance(provenance)).toBe(true);
    generation.revoke();
    expect(isCurrentMCPToolLoaderProvenance(provenance)).toBe(false);
  });

  test('records a truly unchanged runtime name without relying on a rename', () => {
    const mapping = new Map();
    const reverse = new Map();
    const [loaded] = normalizeLoadedMCPTools(
      'agent-a',
      [{ name: 'github_createIssue', execute: vi.fn() }] as any,
      mapping,
      reverse,
      createMCPToolProvenanceGeneration(),
      'github-integration',
      () => ({ serverId: 'github', originalToolName: 'create_issue' }),
      { debug: vi.fn() },
    );

    expect(loaded.name).toBe('github_createIssue');
    expect(mapping.get('github_createIssue')?.provenance).toMatchObject({
      originalToolName: 'create_issue',
      runtimeName: 'github_createIssue',
    });
    expect(reverse.get('github_createIssue')).toBe('github_createIssue');
  });

  test('allows a replacement to reuse a normalized name with a fresh map', () => {
    const initial = new Map();
    normalizeLoadedMCPTools(
      'agent-a',
      [{ name: 'github_create_issue', execute: vi.fn() }] as any,
      initial,
      new Map(),
      createMCPToolProvenanceGeneration(),
      'github-integration',
      () => ({ serverId: 'github', originalToolName: 'create_issue' }),
      { debug: vi.fn() },
    );
    const replacement = new Map();
    expect(() =>
      normalizeLoadedMCPTools(
        'agent-a',
        [{ name: 'github_createIssue', execute: vi.fn() }] as any,
        replacement,
        new Map(),
        createMCPToolProvenanceGeneration(),
        'replacement-integration',
        () => ({ serverId: 'replacement', originalToolName: 'create_issue' }),
        { debug: vi.fn() },
      ),
    ).not.toThrow();
  });

  test('fails closed when different reviewed loader identities collide', () => {
    const mapping = new Map();
    const generation = createMCPToolProvenanceGeneration();
    normalizeLoadedMCPTools(
      'agent-a',
      [{ name: 'github_create_issue', execute: vi.fn() }] as any,
      mapping,
      new Map(),
      generation,
      'github-integration',
      () => ({ serverId: 'github', originalToolName: 'create_issue' }),
      { debug: vi.fn() },
    );
    expect(() =>
      normalizeLoadedMCPTools(
        'agent-a',
        [{ name: 'github_create_issue', execute: vi.fn() }] as any,
        mapping,
        new Map(),
        generation,
        'spoofed-integration',
        () => ({ serverId: 'spoofed', originalToolName: 'create_issue' }),
        { debug: vi.fn() },
      ),
    ).toThrow('MCP runtime tool name collision');
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
