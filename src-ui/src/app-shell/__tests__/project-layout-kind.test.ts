/**
 * @vitest-environment jsdom
 */

import { describe, expect, test } from 'vitest';
import { layoutTypeRegistry } from '../layoutRegistry';
import {
  isBuiltinCodingLayout,
  LAYOUT_TYPE_REGISTRY_KEYS,
  rendersChatWorkspaceLayout,
  resolveLayoutChatPlacement,
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

  test('a withheld plugin binding still renders the layout view (#2090)', () => {
    // The response this dispatch sees has had `config.plugin` AND
    // `catalogContribution` withheld — the two facts every other branch here
    // reads. Without the verdict as the replacement signal, this layout falls
    // through to its `type` and reaches the BUILT-IN coding host, which never
    // renders the per-tab placeholder the withholding exists to produce.
    expect(
      resolveProjectLayoutRendererKind({
        type: 'coding',
        config: { tabs: [{ id: 'notes' }] },
        paneReferences: { unavailableTabIds: ['notes'] },
      }),
    ).toBe('layout-view');
    // A layout with no tabs stored still carries the verdict, with an empty
    // list: presence, not length, is what says the binding was withheld.
    expect(
      resolveProjectLayoutRendererKind({
        type: 'coding',
        config: {},
        paneReferences: { unavailableTabIds: [] },
      }),
    ).toBe('layout-view');
    // The control: the same record with nothing withheld is the built-in
    // Coding stack.
    expect(
      resolveProjectLayoutRendererKind({ type: 'coding', config: {} }),
    ).toBe('stack');
    // A withheld answer that also states a stack still renders the layout
    // view: the verdict dominates whatever the response says.
    expect(
      resolveProjectLayoutRendererKind({
        type: 'custom',
        config: {},
        presentation: 'stack',
        primary: 'chat',
        paneReferences: { unavailableTabIds: [] },
      }),
    ).toBe('layout-view');
  });

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

  test('a stack declaration wins over the registry, and only registry keys reach the registry', () => {
    expect(
      resolveProjectLayoutRendererKind({ type: 'coding', config: {} }),
    ).toBe('stack');
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

  test('a contributed layout typed coding that declares nothing renders its declared tabs, not the stack', () => {
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
    // The server's answer for it states `tabs`: the word grants nothing.
    expect(
      resolveProjectLayoutRendererKind({
        type: 'coding',
        config: { plugin: 'fixture' },
        presentation: 'tabs',
      }),
    ).toBe('layout-view');
  });

  test('a contributed layout declaring presentation stack gets the stack host whatever its type (#2995)', () => {
    // The fixture half of the parity proof at the dispatch seam: reverting
    // the derivation to `type === 'coding'` sends this to the layout view.
    for (const type of ['custom', 'fixture-stack']) {
      expect(
        resolveProjectLayoutRendererKind({
          type,
          config: { plugin: 'fixture' },
          catalogContribution: contributed('plugin'),
          primary: 'chat',
          presentation: 'stack',
          drillIns: ['pane:plugin%3Afixture:stack:one'],
        }),
      ).toBe('stack');
    }
  });

  test('a record whose answer states tabs is not a stack, even typed coding', () => {
    expect(
      resolveProjectLayoutRendererKind({
        type: 'coding',
        config: {},
        presentation: 'tabs',
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

/**
 * Where a layout route puts Station's one Chat controller. App suspends the
 * dock's Chat from this and the Coding host mounts its own from it, so a row
 * that is wrong here is a frame with two controllers or none.
 */
describe('resolveLayoutChatPlacement', () => {
  const withheld = { unavailableTabIds: [] } as never;
  test.each([
    ['no layout yet', undefined, false, 'none'],
    ['the Chat layout', { type: 'chat', config: {} }, false, 'viewport'],
    [
      'the Chat layout, bottom-only',
      { type: 'chat', config: {} },
      true,
      'viewport',
    ],
    [
      'the built-in Coding layout',
      { type: 'coding', config: {} },
      false,
      'center',
    ],
    // Phone Coding uses the same central Chat owner.
    [
      'the built-in Coding layout, bottom-only',
      { type: 'coding', config: {} },
      true,
      'center',
    ],
    [
      'a plugin-contributed layout typed coding',
      {
        type: 'coding',
        config: {},
        catalogContribution: contributed('plugin'),
      },
      false,
      'none',
    ],
    [
      'a persisted plugin layout typed coding',
      { type: 'coding', config: { plugin: 'fixture' } },
      false,
      'none',
    ],
    [
      'a withheld layout typed coding (#2090)',
      { type: 'coding', config: {}, paneReferences: withheld },
      false,
      'none',
    ],
    [
      'the built-in Coding layout as this server answers it',
      {
        type: 'coding',
        config: {},
        primary: 'chat',
        presentation: 'stack',
        drillIns: ['pane:builtin:coding:diff'],
      },
      false,
      'center',
    ],
    [
      'a contributed stack layout declaring primary chat (#2995)',
      {
        type: 'custom',
        config: { plugin: 'fixture' },
        catalogContribution: contributed('plugin'),
        primary: 'chat',
        presentation: 'stack',
        drillIns: ['pane:plugin%3Afixture:stack:one'],
      },
      false,
      'center',
    ],
    [
      'a contributed stack layout answered without its claim (no layout.primaryChat grant)',
      {
        type: 'custom',
        config: { plugin: 'fixture' },
        catalogContribution: contributed('plugin'),
        presentation: 'stack',
        drillIns: ['pane:plugin%3Afixture:stack:one'],
      },
      false,
      'none',
    ],
    [
      'a primary claim without the stack host',
      { type: 'custom', config: {}, primary: 'chat', presentation: 'tabs' },
      false,
      'none',
    ],
    [
      'a withheld answer that states a primary stack',
      {
        type: 'custom',
        config: {},
        primary: 'chat',
        presentation: 'stack',
        paneReferences: withheld,
      },
      false,
      'none',
    ],
    ['the tasks layout', { type: 'tasks', config: {} }, false, 'none'],
    ['an unregistered type', { type: 'custom', config: {} }, false, 'none'],
  ] as const)('%s', (_name, layout, _bottomOnly, expected) => {
    expect(resolveLayoutChatPlacement(layout)).toBe(expected);
  });
});

/**
 * Built-in Coding's own composition (its occurrence, Files/Diff/Terminal and
 * evidence compositions) is the one built-in privilege left in the stack
 * host. A contributed layout never receives it, whatever it is typed or
 * declares.
 */
describe('isBuiltinCodingLayout', () => {
  test('the built-in record, stored or as this server answers it', () => {
    expect(isBuiltinCodingLayout({ type: 'coding', config: {} })).toBe(true);
    expect(
      isBuiltinCodingLayout({
        type: 'coding',
        config: {},
        primary: 'chat',
        presentation: 'stack',
      }),
    ).toBe(true);
  });

  test.each([
    [
      'a plugin layout typed coding declaring a stack',
      {
        type: 'coding',
        config: { plugin: 'fixture' },
        catalogContribution: contributed('plugin'),
        primary: 'chat',
        presentation: 'stack',
      },
    ],
    [
      'a legacy plugin record typed coding declaring a stack',
      {
        type: 'coding',
        config: { plugin: 'fixture' },
        primary: 'chat',
        presentation: 'stack',
      },
    ],
    [
      'a withheld record typed coding',
      {
        type: 'coding',
        config: {},
        paneReferences: { unavailableTabIds: [] },
      },
    ],
    ['an answer stating tabs', { type: 'coding', presentation: 'tabs' }],
    ['another type', { type: 'custom', presentation: 'stack' }],
  ] as const)('not %s', (_name, layout) => {
    expect(isBuiltinCodingLayout(layout)).toBe(false);
  });
});
