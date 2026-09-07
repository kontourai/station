/**
 * @vitest-environment jsdom
 */

import { describe, expect, test } from 'vitest';
import { layoutTypeRegistry } from '../layoutRegistry';
import {
  LAYOUT_TYPE_REGISTRY_KEYS,
  rendersChatWorkspaceLayout,
  resolveProjectLayoutRendererKind,
} from '../project-layout-kind';

const contributed = (origin: 'plugin' | 'mcp' | 'builtin') => ({
  id: `${origin}:fixture:layout`,
  version: '1.0.0',
  sourceIdentity: { id: 'fixture', kind: 'local' as const },
  provenance: { origin },
});

describe('resolveProjectLayoutRendererKind', () => {
  // The pure module restates the registry keys so App's eager chunk never
  // imports the layout components. This pins the restatement to the real
  // registry in both directions: a key added or removed on either side reds.
  test('restates exactly the keys of layoutTypeRegistry', () => {
    expect([...LAYOUT_TYPE_REGISTRY_KEYS].sort()).toEqual(
      Object.keys(layoutTypeRegistry).sort(),
    );
  });

  test('no layout yet resolves to the layout view', () => {
    expect(resolveProjectLayoutRendererKind(undefined)).toBe('layout-view');
    expect(resolveProjectLayoutRendererKind(null)).toBe('layout-view');
  });

  test.each(['plugin', 'mcp'] as const)(
    'a %s-contributed layout renders the layout view whatever its type says',
    (origin) => {
      expect(
        resolveProjectLayoutRendererKind({
          type: 'chat',
          config: {},
          catalogContribution: contributed(origin),
        }),
      ).toBe('layout-view');
      expect(
        rendersChatWorkspaceLayout({
          type: 'chat',
          config: {},
          catalogContribution: contributed(origin),
        }),
      ).toBe(false);
    },
  );

  test('a persisted plugin layout without catalog provenance renders the layout view', () => {
    expect(
      resolveProjectLayoutRendererKind({
        type: 'chat',
        config: { plugin: 'knowledge-docs-starter' },
      }),
    ).toBe('layout-view');
    // An empty plugin string is no attribution, matching the renderer.
    expect(
      resolveProjectLayoutRendererKind({
        type: 'chat',
        config: { plugin: '' },
      }),
    ).toBe('chat');
  });

  test('a builtin contribution is not a contributed layout and dispatches on its type', () => {
    expect(
      resolveProjectLayoutRendererKind({
        type: 'session-board',
        config: {},
        catalogContribution: contributed('builtin'),
      }),
    ).toBe('session-board');
  });

  test('coding wins over the registry, and only registry keys reach the registry', () => {
    expect(
      resolveProjectLayoutRendererKind({ type: 'coding', config: {} }),
    ).toBe('coding');
    expect(resolveProjectLayoutRendererKind({ type: 'chat', config: {} })).toBe(
      'chat',
    );
    expect(
      resolveProjectLayoutRendererKind({ type: 'tasks', config: {} }),
    ).toBe('tasks');
    expect(
      resolveProjectLayoutRendererKind({ type: 'custom', config: {} }),
    ).toBe('layout-view');
    expect(resolveProjectLayoutRendererKind({ config: {} })).toBe(
      'layout-view',
    );
    // A `Record<string, …>` lookup would find `Object.prototype` members; the
    // key set does not.
    expect(
      resolveProjectLayoutRendererKind({ type: 'toString', config: {} }),
    ).toBe('layout-view');
  });

  test('a contributed layout typed coding renders its declared tabs, not the Coding host', () => {
    // Review round 1 (LOW-2): the contributed check must precede the coding
    // branch. A plugin's free-form `type` may intentionally match a built-in
    // type; its declared tabs remain the rendering authority.
    expect(
      resolveProjectLayoutRendererKind({
        type: 'coding',
        config: {},
        catalogContribution: contributed('plugin'),
      }),
    ).toBe('layout-view');
    expect(
      resolveProjectLayoutRendererKind({
        type: 'coding',
        config: { plugin: 'fixture' },
      }),
    ).toBe('layout-view');
  });

  test('only the Station-owned chat layout renders the Chat workspace placement', () => {
    expect(rendersChatWorkspaceLayout({ type: 'chat', config: {} })).toBe(true);
    expect(rendersChatWorkspaceLayout({ type: 'chat' })).toBe(true);
    expect(rendersChatWorkspaceLayout({ type: 'custom', config: {} })).toBe(
      false,
    );
    expect(rendersChatWorkspaceLayout(undefined)).toBe(false);
    // Review round 1 (LOW-3): the other registry entries own their view too,
    // but they do not suspend the ambient regions. Only `chat` does.
    expect(rendersChatWorkspaceLayout({ type: 'tasks', config: {} })).toBe(
      false,
    );
    expect(
      rendersChatWorkspaceLayout({ type: 'session-board', config: {} }),
    ).toBe(false);
    expect(rendersChatWorkspaceLayout({ type: 'coding', config: {} })).toBe(
      false,
    );
  });
});
