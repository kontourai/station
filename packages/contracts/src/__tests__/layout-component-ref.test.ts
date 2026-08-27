import { describe, expect, test } from 'vitest';
import type { LayoutComponentRef, LayoutTab } from '../layout';
import {
  formatMcpToolRef,
  isLayoutComponentRef,
  isValidMcpToolRef,
  normalizeLayoutComponentRef,
  parseMcpToolRef,
} from '../layout';

describe('layout component refs', () => {
  test('normalizes legacy string components to plugin refs', () => {
    expect(normalizeLayoutComponentRef('project-board')).toEqual({
      kind: 'plugin-component',
      name: 'project-board',
    });

    const legacyTab: LayoutTab = {
      id: 'board',
      label: 'Board',
      component: 'project-board',
    };

    expect(legacyTab.component).toBe('project-board');
  });

  test('accepts structured plugin, builtin, and MCP refs on layout tabs', () => {
    const pluginRef = {
      kind: 'plugin-component',
      name: 'review-queue',
    } satisfies LayoutComponentRef;
    const builtinRef = {
      kind: 'builtin-component',
      name: 'default-layout',
    } satisfies LayoutComponentRef;
    const mcpRef = {
      kind: 'mcp-tool-ui',
      ref: 'github/create_issue',
    } satisfies LayoutComponentRef;

    const tabs: LayoutTab[] = [
      { id: 'plugin', label: 'Plugin', component: pluginRef },
      { id: 'builtin', label: 'Builtin', component: builtinRef },
      { id: 'mcp', label: 'MCP', component: mcpRef },
    ];

    expect(
      tabs.map((tab) => normalizeLayoutComponentRef(tab.component)),
    ).toEqual([pluginRef, builtinRef, mcpRef]);
  });

  test('formats and parses canonical MCP tool refs', () => {
    expect(formatMcpToolRef('github', 'create_issue')).toBe(
      'github/create_issue',
    );
    expect(parseMcpToolRef('github/create_issue')).toEqual({
      serverId: 'github',
      toolName: 'create_issue',
    });
    expect(isValidMcpToolRef('github/create_issue')).toBe(true);
  });

  test('rejects malformed MCP tool refs', () => {
    const malformedRefs = [
      '',
      'github',
      'github/',
      '/create_issue',
      'github/create/issue',
      ' github/create_issue',
      'github/create_issue ',
      'github server/create_issue',
      'github/create issue',
    ];

    for (const ref of malformedRefs) {
      expect(parseMcpToolRef(ref)).toBeNull();
      expect(isValidMcpToolRef(ref)).toBe(false);
      expect(() =>
        normalizeLayoutComponentRef({ kind: 'mcp-tool-ui', ref }),
      ).toThrow(TypeError);
    }

    expect(() => formatMcpToolRef('github', 'create/issue')).toThrow(TypeError);
  });

  test('identifies valid component refs without accepting malformed objects', () => {
    expect(
      isLayoutComponentRef({ kind: 'plugin-component', name: 'project-board' }),
    ).toBe(true);
    expect(isLayoutComponentRef({ kind: 'builtin-component', name: '' })).toBe(
      false,
    );
    expect(
      isLayoutComponentRef({ kind: 'mcp-tool-ui', ref: 'github/create_issue' }),
    ).toBe(true);
    expect(isLayoutComponentRef({ kind: 'unknown', name: 'x' })).toBe(false);
  });
});
