import { describe, expect, test } from 'vitest';

import type { LayoutDefinition, LayoutTab } from '../layout';
import {
  createWorkspacePaneCatalogFromAdaptations,
  enumerateLayoutDefinitionPanes,
  enumerateLayoutPanes,
  layoutTabFromWorkspacePaneAdaptation,
  MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH,
  paneAdaptationFromLayoutTab,
  type WorkspacePaneLayoutAdapterContext,
  type WorkspacePaneLayoutTabAdaptation,
} from '../workspace-pane-layout-adapter';
import {
  adapt,
  baselineStringTab,
  builtinTab,
  context,
  mcpTab,
  pluginTab,
} from './workspace-pane-layout-adapter.test-fixtures';

describe('layout definition enumeration', () => {
  function mixedLayout(): LayoutDefinition {
    return {
      name: 'Synthetic Layout',
      slug: 'synthetic-layout',
      // Present but never read for provenance: attribution comes from context.
      plugin: 'synthetic-plugin',
      requiredProviders: ['synthetic-provider'],
      tabs: [builtinTab(), pluginTab(), mcpTab(), baselineStringTab()],
    };
  }

  function enumerateMixed(
    overrides: Partial<WorkspacePaneLayoutAdapterContext> = {},
  ): WorkspacePaneLayoutTabAdaptation[] {
    const adaptations = enumerateLayoutDefinitionPanes(
      mixedLayout(),
      context({ pluginId: 'synthetic-plugin', ...overrides }),
    );
    expect(adaptations).not.toBeNull();
    return adaptations as WorkspacePaneLayoutTabAdaptation[];
  }

  test('enumerates every tab in declared order with matching placement order', () => {
    const adaptations = enumerateMixed();

    expect(adaptations.map((a) => a.descriptor.id)).toEqual([
      'pane:plugin%3Asynthetic-plugin:synthetic-layout:files',
      'pane:plugin%3Asynthetic-plugin:synthetic-layout:review-queue',
      'pane:plugin%3Asynthetic-plugin:synthetic-layout:issue-ui',
      'pane:plugin%3Asynthetic-plugin:synthetic-layout:terminal',
    ]);
    expect(adaptations.map((a) => a.descriptor.placement.order)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  test('preserves the plugin contributor across renderer security classes', () => {
    expect(enumerateMixed().map((a) => a.descriptor.provenance)).toEqual([
      { origin: 'plugin', pluginId: 'synthetic-plugin' },
      { origin: 'plugin', pluginId: 'synthetic-plugin' },
      {
        origin: 'plugin',
        pluginId: 'synthetic-plugin',
        mcpServerId: 'synthetic-server',
      },
      { origin: 'plugin', pluginId: 'synthetic-plugin' },
    ]);
  });

  test('is deterministic: repeated enumeration yields identical output', () => {
    expect(enumerateMixed()).toEqual(enumerateMixed());
  });

  test('folds layout-level declarations into the context requirement', () => {
    const [first] = enumerateMixed({ requiresProject: true });
    expect(first.descriptor.modes[0].contextRequirement).toEqual({
      project: true,
      requiredProviders: ['synthetic-provider'],
    });
  });

  test('round-trips every enumerated tab back to the original layout tabs', () => {
    expect(enumerateMixed().map(layoutTabFromWorkspacePaneAdaptation)).toEqual(
      mixedLayout().tabs,
    );
  });

  test('gives two enumeration scopes independent instances of equal descriptors', () => {
    const first = enumerateMixed({ instanceScope: 'window-a' });
    const second = enumerateMixed({ instanceScope: 'window-b' });

    expect(first.map((a) => a.descriptor)).toEqual(
      second.map((a) => a.descriptor),
    );
    expect(first[0].instance.descriptorId).toBe(
      second[0].instance.descriptorId,
    );
    expect(first[0].instance.instanceId).not.toBe(
      second[0].instance.instanceId,
    );
    expect(first[0].instance.stateKey).not.toBe(second[0].instance.stateKey);
    expect(first[0].instance).toEqual({
      version: '1.0',
      descriptorId: 'pane:plugin%3Asynthetic-plugin:synthetic-layout:files',
      instanceId:
        'instance:window-a:pane:plugin%3Asynthetic-plugin:synthetic-layout:files',
      stateKey:
        'state:window-a:pane:plugin%3Asynthetic-plugin:synthetic-layout:files',
    });
  });

  test('rejects a layout whose tab ids repeat', () => {
    const layout = { ...mixedLayout(), tabs: [builtinTab(), builtinTab()] };
    expect(enumerateLayoutDefinitionPanes(layout, context())).toBeNull();
  });

  test('rejects the whole enumeration when any tab is malformed', () => {
    const layout = {
      ...mixedLayout(),
      tabs: [builtinTab(), { id: 'broken', label: 'Broken', component: 42 }],
    };
    expect(enumerateLayoutDefinitionPanes(layout, context())).toBeNull();
  });

  test('rejects a layout with no tabs array', () => {
    expect(
      enumerateLayoutDefinitionPanes({ slug: 'no-tabs' }, context()),
    ).toBeNull();
    expect(enumerateLayoutDefinitionPanes(null, context())).toBeNull();
  });
});

describe('malformed adapter context', () => {
  const malformed: ReadonlyArray<[string, unknown]> = [
    ['not an object', 'synthetic-layout'],
    ['missing layoutSlug', {}],
    ['empty layoutSlug', { layoutSlug: '' }],
    ['padded layoutSlug', { layoutSlug: '  synthetic-layout  ' }],
    [
      'empty instanceScope',
      { layoutSlug: 'synthetic-layout', instanceScope: '' },
    ],
    ['unknown region', { layoutSlug: 'synthetic-layout', region: 'sidebar' }],
    [
      'non-boolean requiresProject',
      { layoutSlug: 'synthetic-layout', requiresProject: 'yes' },
    ],
    ['empty pluginId', { layoutSlug: 'synthetic-layout', pluginId: '' }],
    [
      'empty mcpServerId',
      { layoutSlug: 'synthetic-layout', mcpServerId: '  ' },
    ],
  ];

  for (const [name, value] of malformed) {
    test(`rejects a context that is ${name}`, () => {
      const badContext = value as WorkspacePaneLayoutAdapterContext;
      expect(paneAdaptationFromLayoutTab(builtinTab(), badContext)).toBeNull();
      expect(
        enumerateLayoutDefinitionPanes(
          { slug: 'synthetic-layout', tabs: [builtinTab()] },
          badContext,
        ),
      ).toBeNull();
    });
  }

  test('rejects a malformed lifecycle through the contract parser', () => {
    expect(
      paneAdaptationFromLayoutTab(
        builtinTab(),
        context({
          lifecycle: { stage: 'retired' } as never,
        }),
      ),
    ).toBeNull();
  });

  test('fails closed on hostile lifecycle and context data without evaluating accessors', () => {
    const cyclicLifecycle: Record<string, unknown> = { stage: 'stable' };
    cyclicLifecycle.self = cyclicLifecycle;
    let lifecycleGetterReads = 0;
    const lifecycleWithGetter = Object.defineProperty({}, 'stage', {
      enumerable: true,
      get: () => {
        lifecycleGetterReads += 1;
        throw new Error('lifecycle getter must not run');
      },
    });
    let contextProxyReads = 0;
    const contextRequirementProxy = new Proxy(
      { project: true },
      {
        get: () => {
          contextProxyReads += 1;
          throw new Error('context proxy get trap must not run');
        },
      },
    );
    const malformed: readonly WorkspacePaneLayoutAdapterContext[] = [
      context({ lifecycle: new Date() as never }),
      context({ lifecycle: cyclicLifecycle as never }),
      context({ lifecycle: lifecycleWithGetter as never }),
      context({ modeContextRequirement: contextRequirementProxy as never }),
    ];

    for (const badContext of malformed) {
      expect(() =>
        paneAdaptationFromLayoutTab(builtinTab(), badContext),
      ).not.toThrow();
      expect(paneAdaptationFromLayoutTab(builtinTab(), badContext)).toBeNull();
    }
    expect(lifecycleGetterReads).toBe(0);
    expect(contextProxyReads).toBe(0);
  });

  test('fails closed on hostile renderer data without evaluating accessors', () => {
    let rendererGetterReads = 0;
    const rendererWithGetter = Object.defineProperty(
      { kind: 'builtin-component' },
      'name',
      {
        enumerable: true,
        get: () => {
          rendererGetterReads += 1;
          throw new Error('renderer getter must not run');
        },
      },
    );
    let rendererProxyReads = 0;
    const rendererProxy = new Proxy(
      { kind: 'builtin-component', name: 'file-tree' },
      {
        get: () => {
          rendererProxyReads += 1;
          throw new Error('renderer proxy get trap must not run');
        },
      },
    );
    const cyclicInitialArguments: Record<string, unknown> = {
      repo: 'synthetic/repo',
    };
    cyclicInitialArguments.self = cyclicInitialArguments;
    const malformedComponents = [
      new Date(),
      rendererWithGetter,
      rendererProxy,
      {
        kind: 'mcp-tool-ui',
        ref: 'synthetic-server/create_issue',
        initialArguments: cyclicInitialArguments,
      },
    ];

    for (const component of malformedComponents) {
      const tab = { ...builtinTab(), component } as unknown as LayoutTab;
      expect(() => paneAdaptationFromLayoutTab(tab, context())).not.toThrow();
      expect(paneAdaptationFromLayoutTab(tab, context())).toBeNull();
    }
    expect(rendererGetterReads).toBe(0);
    expect(rendererProxyReads).toBe(0);
  });
});

describe('minted identity bounds', () => {
  test('escapes separators so two different contexts cannot collide on one identity', () => {
    const left = paneAdaptationFromLayoutTab(
      { ...builtinTab(), id: 'files' },
      context({ layoutSlug: 'workspace:left' }),
    );
    const right = paneAdaptationFromLayoutTab(
      { ...builtinTab(), id: 'left:files' },
      context({ layoutSlug: 'workspace' }),
    );

    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    // Joined raw, both would read `pane:builtin:workspace:left:files` and
    // the catalog would reject one contributor's tab as a duplicate of the
    // other's.
    expect(left?.descriptor.id).not.toBe(right?.descriptor.id);
    expect(left?.descriptor.id).toBe('pane:builtin:workspace%3Aleft:files');
    expect(right?.descriptor.id).toBe('pane:builtin:workspace:left%3Afiles');
  });

  test('gives two plugins contributing the same layout/tab/component distinct descriptor and renderer ids', () => {
    const alpha = adapt(pluginTab(), { pluginId: 'alpha-plugin' });
    const omega = adapt(pluginTab(), { pluginId: 'omega-plugin' });

    // Before the contributor identity segment existed, both would have
    // minted `pane:synthetic-layout:review-queue` /
    // `renderer:plugin-component:review-queue-panel` and collided.
    expect(alpha.descriptor.id).not.toBe(omega.descriptor.id);
    expect(alpha.descriptor.rendererId).not.toBe(omega.descriptor.rendererId);
  });

  test('gives two MCP servers contributing the same layout/tab distinct descriptor ids', () => {
    const tab = (serverId: string): LayoutTab => ({
      id: 'issue-ui',
      label: 'Issue',
      component: { kind: 'mcp-tool-ui', ref: `${serverId}/create_issue` },
    });
    const alpha = adapt(tab('alpha-server'));
    const omega = adapt(tab('omega-server'));

    // Before the contributor identity segment existed, descriptor ids were
    // minted from layout slug and tab id alone, so same layout/tab from two
    // MCP servers would have collided on the descriptor even though their
    // renderers differ.
    expect(alpha.descriptor.id).not.toBe(omega.descriptor.id);
    expect(alpha.descriptor.rendererId).not.toBe(omega.descriptor.rendererId);
  });

  test('bounds every derived segment while preserving a valid composed instance scope', () => {
    const oversized = 'x'.repeat(
      MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH + 1,
    );
    const atLimit = 'x'.repeat(MAX_WORKSPACE_PANE_IDENTITY_SEGMENT_LENGTH);

    expect(
      paneAdaptationFromLayoutTab(
        { ...builtinTab(), id: oversized },
        context(),
      ),
    ).toBeNull();
    expect(
      paneAdaptationFromLayoutTab(
        builtinTab(),
        context({ layoutSlug: oversized }),
      ),
    ).toBeNull();
    const longScopeAdaptation = paneAdaptationFromLayoutTab(
      builtinTab(),
      context({ instanceScope: oversized }),
    );
    expect(longScopeAdaptation?.instance.instanceId).toMatch(
      /^instance:scope-h1-[1-9a-z][0-9a-z]*-[0-9a-f]{16}:/,
    );
    expect(
      paneAdaptationFromLayoutTab(
        {
          ...builtinTab(),
          component: { kind: 'builtin-component', name: oversized },
        },
        context(),
      ),
    ).toBeNull();
    expect(
      paneAdaptationFromLayoutTab({ ...builtinTab(), id: atLimit }, context()),
    ).not.toBeNull();
  });
});

describe('enumerating several supplied layout definitions', () => {
  function twoLayouts() {
    return [
      {
        layout: {
          slug: 'layout-one',
          tabs: [builtinTab(), baselineStringTab()],
        },
        context: context({
          layoutSlug: 'layout-one',
          pluginId: 'synthetic-plugin',
        }),
      },
      {
        layout: { slug: 'layout-two', tabs: [mcpTab()] },
        context: context({ layoutSlug: 'layout-two' }),
      },
    ];
  }

  test('flattens layouts in supplied order, then declared tab order', () => {
    const adaptations = enumerateLayoutPanes(twoLayouts());

    expect(adaptations?.map((a) => a.descriptor.id)).toEqual([
      'pane:plugin%3Asynthetic-plugin:layout-one:files',
      'pane:plugin%3Asynthetic-plugin:layout-one:terminal',
      'pane:mcp%3Asynthetic-server:layout-two:issue-ui',
    ]);
  });

  test('feeds a catalog that preserves each layout’s own provenance', () => {
    const adaptations = enumerateLayoutPanes(twoLayouts());
    const catalog = createWorkspacePaneCatalogFromAdaptations(
      adaptations as WorkspacePaneLayoutTabAdaptation[],
    );

    expect(catalog.size).toBe(3);
    // Catalog order is the catalog's own — placement order, then id — not the
    // enumeration order, and each entry keeps the provenance it was contributed
    // with across that reordering.
    expect(catalog.list().map((d) => [d.id, d.provenance])).toEqual([
      [
        'pane:mcp%3Asynthetic-server:layout-two:issue-ui',
        { origin: 'mcp', mcpServerId: 'synthetic-server' },
      ],
      [
        'pane:plugin%3Asynthetic-plugin:layout-one:files',
        { origin: 'plugin', pluginId: 'synthetic-plugin' },
      ],
      [
        'pane:plugin%3Asynthetic-plugin:layout-one:terminal',
        { origin: 'plugin', pluginId: 'synthetic-plugin' },
      ],
    ]);
  });

  test('keeps same-named tabs from different layouts distinct in one scope', () => {
    const shared = { instanceScope: 'window-a' };
    const adaptations = enumerateLayoutPanes([
      {
        layout: { slug: 'layout-one', tabs: [builtinTab()] },
        context: context({ layoutSlug: 'layout-one', ...shared }),
      },
      {
        layout: { slug: 'layout-two', tabs: [builtinTab()] },
        context: context({ layoutSlug: 'layout-two', ...shared }),
      },
    ]) as WorkspacePaneLayoutTabAdaptation[];

    expect(adaptations[0].instance.instanceId).not.toBe(
      adaptations[1].instance.instanceId,
    );
    expect(adaptations[0].instance.stateKey).not.toBe(
      adaptations[1].instance.stateKey,
    );
    // Both placements are still real catalog entries, not a collapsed one.
    expect(
      createWorkspacePaneCatalogFromAdaptations(adaptations).instanceCount,
    ).toBe(2);
  });

  test('fails closed rather than under-reporting when any layout is malformed', () => {
    expect(
      enumerateLayoutPanes([
        twoLayouts()[0],
        { layout: { slug: 'broken' }, context: context() },
      ]),
    ).toBeNull();
    expect(
      enumerateLayoutPanes([
        { layout: { slug: 'x', tabs: [builtinTab()] }, context: {} as never },
      ]),
    ).toBeNull();
  });
});
