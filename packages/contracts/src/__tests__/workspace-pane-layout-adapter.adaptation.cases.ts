import { describe, expect, test } from 'vitest';

import type { LayoutTab } from '../layout';
import {
  layoutTabFromWorkspacePaneAdaptation,
  paneAdaptationFromLayoutTab,
  type WorkspacePaneLayoutAdapterContext,
} from '../workspace-pane-layout-adapter';
import {
  adapt,
  baselineStringTab,
  builtinTab,
  context,
  mcpTab,
  pluginTab,
} from './workspace-pane-layout-adapter.test-fixtures';

function nestedInitialArguments(depth: number): Record<string, unknown> {
  let initialArguments: Record<string, unknown> = { value: 'leaf' };
  for (let index = 0; index < depth; index += 1) {
    initialArguments = { nested: initialArguments };
  }
  return initialArguments;
}

describe('baseline layout tab adaptation', () => {
  test('adapts a synthetic built-in tab with builtin provenance', () => {
    const { descriptor } = adapt(builtinTab());

    expect(descriptor).toEqual({
      version: '1.0',
      id: 'pane:builtin:synthetic-layout:files',
      name: 'Files',
      description: 'Working directory file tree',
      icon: '📁',
      rendererId: 'renderer:builtin:builtin-component:file-tree',
      renderer: { kind: 'builtin-component', name: 'file-tree' },
      placement: { supportedRegions: ['primary'], preferredRegion: 'primary' },
      modes: [{ id: 'default' }],
      provenance: { origin: 'builtin' },
      lifecycle: { stage: 'stable' },
    });
  });

  test('adapts a synthetic trusted-plugin tab with supplied attribution', () => {
    const { descriptor } = adapt(pluginTab(), {
      pluginId: 'synthetic-plugin',
      region: 'secondary',
    });

    expect(descriptor.renderer).toEqual({
      kind: 'plugin-component',
      name: 'review-queue-panel',
    });
    expect(descriptor.provenance).toEqual({
      origin: 'plugin',
      pluginId: 'synthetic-plugin',
    });
    expect(descriptor.placement).toEqual({
      supportedRegions: ['secondary'],
      preferredRegion: 'secondary',
    });
    // Tab actions become WorkspacePane actions; retained `prompts` have no WorkspacePane home.
    expect(descriptor.actions).toEqual(pluginTab().actions);
    expect(descriptor).not.toHaveProperty('prompts');
  });

  test('retains an exact catalog contribution on a layout-derived occurrence and rejects disagreeing attribution', () => {
    const contribution = {
      id: 'plugin:synthetic-plugin:synthetic-layout',
      version: '1.2.3',
      sourceIdentity: {
        id: 'synthetic-plugin',
        kind: 'local' as const,
        source: 'plugins/synthetic-plugin',
      },
      provenance: {
        origin: 'plugin' as const,
        pluginId: 'synthetic-plugin',
      },
    };
    const adapted = paneAdaptationFromLayoutTab(
      pluginTab(),
      context({ pluginId: 'synthetic-plugin', contribution }),
    );

    expect(adapted?.instance.boundContext?.contribution).toEqual(contribution);
    expect(
      paneAdaptationFromLayoutTab(
        pluginTab(),
        context({
          pluginId: 'synthetic-plugin',
          contribution: {
            ...contribution,
            provenance: { origin: 'plugin', pluginId: 'other-plugin' },
          },
        }),
      ),
    ).toBeNull();
  });

  test('fails closed on a plugin tab with no supplied pluginId', () => {
    expect(paneAdaptationFromLayoutTab(pluginTab(), context())).toBeNull();
  });

  test('adapts a synthetic sandboxed MCP App tab, reading the server id from its ref', () => {
    const { descriptor } = adapt(mcpTab());

    expect(descriptor.renderer).toEqual(mcpTab().component);
    expect(descriptor.provenance).toEqual({
      origin: 'mcp',
      mcpServerId: 'synthetic-server',
    });
    // The ref is escaped into the identity, so a `/` (or a `:`) inside a
    // renderer target can never be read as an identity separator.
    expect(descriptor.rendererId).toBe(
      'renderer:mcp%3Asynthetic-server:mcp-tool-ui:synthetic-server%2Fcreate_issue',
    );
  });

  test('adapts a third-party MCP App alternative without changing its contributor identity', () => {
    const contribution = {
      id: 'plugin:third-party-review:review',
      version: '2.4.0',
      sourceIdentity: {
        id: 'third-party-review',
        kind: 'remote' as const,
        source: 'https://plugins.example.test/review',
      },
      provenance: {
        origin: 'plugin' as const,
        pluginId: 'third-party-review',
      },
    };
    const adaptation = paneAdaptationFromLayoutTab(
      {
        id: 'issues',
        label: 'Issues',
        component: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
        requiredRendererCapabilities: ['sandboxed-mcp-app'],
        alternativeRenderer: {
          rendererId: 'renderer:third-party:read-only',
          component: { kind: 'plugin-component', name: 'issues-read-only' },
          provenance: { origin: 'plugin', pluginId: 'third-party-review' },
          requiredCapabilities: ['trusted-plugin-react'],
          reason: 'Use the read-only pane when MCP Apps are unavailable.',
        },
      },
      context({ pluginId: 'third-party-review', contribution }),
    )!;

    expect(adaptation.descriptor).toMatchObject({
      renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
      requiredRendererCapabilities: ['sandboxed-mcp-app'],
      alternativeRenderer: {
        rendererId: 'renderer:third-party:read-only',
        renderer: { kind: 'plugin-component', name: 'issues-read-only' },
        provenance: { origin: 'plugin', pluginId: 'third-party-review' },
        requiredCapabilities: ['trusted-plugin-react'],
      },
      provenance: {
        origin: 'plugin',
        pluginId: 'third-party-review',
        mcpServerId: 'third-party-mcp',
      },
    });
    expect(adaptation.instance.boundContext?.contribution).toEqual(
      contribution,
    );
    expect(layoutTabFromWorkspacePaneAdaptation(adaptation)).toEqual({
      id: 'issues',
      label: 'Issues',
      component: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
      requiredRendererCapabilities: ['sandboxed-mcp-app'],
      alternativeRenderer: {
        rendererId: 'renderer:third-party:read-only',
        component: { kind: 'plugin-component', name: 'issues-read-only' },
        provenance: { origin: 'plugin', pluginId: 'third-party-review' },
        requiredCapabilities: ['trusted-plugin-react'],
        reason: 'Use the read-only pane when MCP Apps are unavailable.',
      },
    });
  });

  test('accepts an agreeing supplied MCP server id and rejects a disagreeing one', () => {
    expect(
      adapt(mcpTab(), { mcpServerId: 'synthetic-server' }).descriptor
        .provenance,
    ).toEqual({ origin: 'mcp', mcpServerId: 'synthetic-server' });

    expect(
      paneAdaptationFromLayoutTab(
        mcpTab(),
        context({ mcpServerId: 'other-server' }),
      ),
    ).toBeNull();
  });

  test('rejects every dangerous MCP initialArguments variant instead of dropping or rewriting it', () => {
    const cyclic: Record<string, unknown> = { repo: 'synthetic/repo' };
    cyclic.self = cyclic;
    const dangerous: Record<string, unknown> = {};
    Object.defineProperty(dangerous, 'constructor', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });

    const variants = [
      { createdAt: new Date() },
      { labels: ['bug', undefined] },
      cyclic,
      dangerous,
    ];

    for (const initialArguments of variants) {
      const tab = {
        ...mcpTab(),
        component: {
          ...(mcpTab().component as Extract<
            LayoutTab['component'],
            { kind: 'mcp-tool-ui' }
          >),
          initialArguments: initialArguments as never,
        },
      };
      expect(paneAdaptationFromLayoutTab(tab, context())).toBeNull();
    }
  });

  test('accepts MCP initialArguments through depth 32 and rejects depth 33', () => {
    const component = mcpTab().component as Extract<
      LayoutTab['component'],
      { kind: 'mcp-tool-ui' }
    >;
    const tabAtDepth = (depth: number): LayoutTab => ({
      ...mcpTab(),
      component: {
        ...component,
        initialArguments: nestedInitialArguments(depth),
      },
    });

    expect(
      paneAdaptationFromLayoutTab(tabAtDepth(32), context()),
    ).not.toBeNull();
    expect(paneAdaptationFromLayoutTab(tabAtDepth(33), context())).toBeNull();
  });

  test('clones valid nested MCP initialArguments so later source mutation cannot affect the adaptation', () => {
    const initialArguments = { repo: 'synthetic/repo', labels: ['bug', 'ui'] };
    const tab = {
      ...mcpTab(),
      component: {
        ...(mcpTab().component as Extract<
          LayoutTab['component'],
          { kind: 'mcp-tool-ui' }
        >),
        initialArguments,
      },
    };

    const adaptation = adapt(tab);
    initialArguments.repo = 'mutated/repo';
    initialArguments.labels.push('mutated');

    const expected = { repo: 'synthetic/repo', labels: ['bug', 'ui'] };
    const retainedComponent = adaptation.retainedLayoutTab.component as Extract<
      LayoutTab['component'],
      { kind: 'mcp-tool-ui' }
    >;
    expect(retainedComponent.initialArguments).toEqual(expected);
    expect(
      (
        adaptation.descriptor.renderer as Extract<
          typeof adaptation.descriptor.renderer,
          { kind: 'mcp-tool-ui' }
        >
      ).initialArguments,
    ).toEqual(expected);
  });

  test('fails closed on a malformed MCP tool ref', () => {
    const tab = {
      ...mcpTab(),
      component: { kind: 'mcp-tool-ui', ref: 'missing-tool-segment' },
    } as LayoutTab;

    expect(paneAdaptationFromLayoutTab(tab, context())).toBeNull();
  });

  test('reads a baseline string component as its existing plugin shorthand', () => {
    const asPlugin = adapt(baselineStringTab(), {
      pluginId: 'synthetic-plugin',
    }).descriptor;
    expect(asPlugin.renderer).toEqual({
      kind: 'plugin-component',
      name: 'terminal-panel',
    });
    expect(asPlugin.provenance).toEqual({
      origin: 'plugin',
      pluginId: 'synthetic-plugin',
    });
  });

  test('mints descriptor, renderer, instance, and state identities as four distinct values', () => {
    const { descriptor, instance } = adapt(builtinTab());
    const identities = [
      descriptor.id,
      descriptor.rendererId,
      instance.instanceId,
      instance.stateKey,
    ];

    expect(new Set(identities).size).toBe(identities.length);
    expect(instance).toEqual({
      version: '1.0',
      descriptorId: 'pane:builtin:synthetic-layout:files',
      instanceId:
        'instance:synthetic-layout:pane:builtin:synthetic-layout:files',
      stateKey: 'state:synthetic-layout:pane:builtin:synthetic-layout:files',
    });
  });

  test('drops additive unknown fields on the tab and its component ref', () => {
    const tab = {
      ...builtinTab(),
      futureTabField: 'ignored',
      component: {
        kind: 'builtin-component',
        name: 'file-tree',
        futureRefField: 'ignored',
      },
    } as unknown as LayoutTab;

    const adaptation = adapt(tab);
    expect(adaptation.retainedLayoutTab).not.toHaveProperty('futureTabField');
    expect(adaptation.retainedLayoutTab.component).not.toHaveProperty(
      'futureRefField',
    );
    expect(adaptation.descriptor.renderer).not.toHaveProperty('futureRefField');
  });

  test('normalizes empty decorations in the descriptor while preserving lossless retained-layout write-back', () => {
    const adaptation = adapt({
      ...builtinTab(),
      icon: '',
      description: '',
    });

    expect(adaptation.descriptor).not.toHaveProperty('icon');
    expect(adaptation.descriptor).not.toHaveProperty('description');
    expect(layoutTabFromWorkspacePaneAdaptation(adaptation)).toEqual({
      id: 'files',
      label: 'Files',
      component: { kind: 'builtin-component', name: 'file-tree' },
      icon: '',
      description: '',
    });
  });
});

describe('baseline layout tab round trips', () => {
  const cases: ReadonlyArray<
    [string, LayoutTab, Partial<WorkspacePaneLayoutAdapterContext>]
  > = [
    ['built-in structured ref', builtinTab(), {}],
    [
      'trusted-plugin structured ref',
      pluginTab(),
      { pluginId: 'synthetic-plugin' },
    ],
    ['sandboxed MCP App ref with every optional', mcpTab(), {}],
    [
      'baseline bare-string component',
      baselineStringTab(),
      { pluginId: 'synthetic-plugin' },
    ],
  ];

  for (const [name, tab, overrides] of cases) {
    test(`round-trips a ${name} exactly`, () => {
      const restored = layoutTabFromWorkspacePaneAdaptation(
        adapt(tab, overrides),
      );
      expect(restored).toEqual(tab);
    });
  }

  test('preserves the string spelling rather than promoting it to a ref', () => {
    const restored = layoutTabFromWorkspacePaneAdaptation(
      adapt(baselineStringTab(), { pluginId: 'synthetic-plugin' }),
    );
    expect(restored.component).toBe('terminal-panel');
  });

  test('preserves every optional MCP field through the round trip', () => {
    const restored = layoutTabFromWorkspacePaneAdaptation(adapt(mcpTab()));
    expect(restored.component).toEqual({
      kind: 'mcp-tool-ui',
      ref: 'synthetic-server/create_issue',
      resourceUri: 'ui://synthetic-server/create_issue',
      displayMode: 'fullscreen',
      fallbackComponent: 'unavailable-pane',
      initialArguments: { repo: 'synthetic/repo', labels: ['bug', 'ui'] },
      approvalPolicy: 'require',
    });
  });

  test('preserves retained per-tab skills the WorkspacePane contract does not model', () => {
    const restored = layoutTabFromWorkspacePaneAdaptation(
      adapt(pluginTab(), { pluginId: 'synthetic-plugin' }),
    );
    expect(restored.skills).toEqual(pluginTab().skills);
  });

  test('restores an independent copy that cannot alias the adaptation', () => {
    const adaptation = adapt(mcpTab());
    const restored = layoutTabFromWorkspacePaneAdaptation(adaptation);

    expect(restored).not.toBe(adaptation.retainedLayoutTab);
    expect(restored.component).not.toBe(adaptation.retainedLayoutTab.component);

    (restored.component as { ref: string }).ref = 'mutated/ref';
    expect(
      (adaptation.retainedLayoutTab.component as { ref: string }).ref,
    ).toBe('synthetic-server/create_issue');
    expect(layoutTabFromWorkspacePaneAdaptation(adaptation)).toEqual(mcpTab());
  });

  test('is unaffected by the source tab mutating after adaptation', () => {
    const tab = builtinTab();
    const adaptation = adapt(tab);
    tab.label = 'Mutated';

    expect(layoutTabFromWorkspacePaneAdaptation(adaptation).label).toBe(
      'Files',
    );
    expect(adaptation.descriptor.name).toBe('Files');
  });
});

describe('MCP initialArguments fail closed rather than rewrite', () => {
  function mcpTabWithInitialArguments(initialArguments: unknown): LayoutTab {
    const tab = mcpTab();
    return {
      ...tab,
      component: {
        ...(tab.component as Extract<
          LayoutTab['component'],
          { kind: 'mcp-tool-ui' }
        >),
        initialArguments: initialArguments as never,
      },
    };
  }

  test('rejects a tab whose initialArguments nests a Date rather than dropping or rewriting it', () => {
    const tab = mcpTabWithInitialArguments({ createdAt: new Date() });
    expect(paneAdaptationFromLayoutTab(tab, context())).toBeNull();
  });

  test('rejects a tab whose initialArguments contains undefined inside an array', () => {
    const tab = mcpTabWithInitialArguments({ labels: ['bug', undefined] });
    expect(paneAdaptationFromLayoutTab(tab, context())).toBeNull();
  });

  test('rejects a tab whose initialArguments carries a dangerous own key', () => {
    const dangerous: Record<string, unknown> = {};
    Object.defineProperty(dangerous, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    const tab = mcpTabWithInitialArguments(dangerous);
    expect(paneAdaptationFromLayoutTab(tab, context())).toBeNull();
  });

  test('rejects a tab whose initialArguments is cyclic', () => {
    const cyclic: Record<string, unknown> = { repo: 'synthetic/repo' };
    cyclic.self = cyclic;
    const tab = mcpTabWithInitialArguments(cyclic);
    expect(paneAdaptationFromLayoutTab(tab, context())).toBeNull();
  });

  test('adapting a valid initialArguments payload never aliases the source, so later source mutation cannot affect the adaptation', () => {
    const initialArguments = { repo: 'synthetic/repo', labels: ['bug', 'ui'] };
    const tab = mcpTabWithInitialArguments(initialArguments);

    const adaptation = paneAdaptationFromLayoutTab(tab, context());
    expect(adaptation).not.toBeNull();

    initialArguments.repo = 'mutated/repo';
    initialArguments.labels.push('mutated');

    const component = adaptation!.retainedLayoutTab.component as Extract<
      LayoutTab['component'],
      { kind: 'mcp-tool-ui' }
    >;
    expect(component.initialArguments).toEqual({
      repo: 'synthetic/repo',
      labels: ['bug', 'ui'],
    });
  });
});
