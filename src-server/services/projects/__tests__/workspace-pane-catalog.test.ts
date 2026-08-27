import type {
  LayoutCatalogItem,
  ResolvedCatalogLayout,
} from '@kontourai/station-contracts/distribution';
import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-browser-preview';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_PLAN_PANE_INSTANCE_ID,
  WORKSPACE_PLAN_PANE_SOURCE_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_INSTANCE_ID,
  WORKSPACE_READINESS_PANE_SOURCE_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_INSTANCE_ID,
  WORKSPACE_TRUST_PANE_SOURCE_ID,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import { parseWorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { resolveWorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import {
  WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR,
  WORKSPACE_SPATIAL_BOARD_PANE_SOURCE_ID,
} from '@kontourai/station-contracts/workspace-spatial-board';
import { describe, expect, test } from 'vitest';
import type { DistributionProfileService } from '../../plugins/distribution-profile-service';
import { readCurrentWorkspacePaneCatalog } from '../workspace-pane-catalog';
import { KNOWN_WORKSPACE_PANE_DECLARATIONS } from '../workspace-pane-known-declarations';

const knownDescriptorCount = KNOWN_WORKSPACE_PANE_DECLARATIONS.length;
/**
 * Built-in declarations that materialize an INSTANCE (they carry an instance
 * factory) rather than contributing a descriptor alone. Chat and Work Board
 * are fixed Project panes in this set, so deriving their count keeps the next
 * such move from reddening this case for a reason it has nothing to do with
 * (station#2221).
 */
const knownInstanceFactoryCount = KNOWN_WORKSPACE_PANE_DECLARATIONS.filter(
  (declaration) => typeof declaration.createInstance === 'function',
).length;

const builtin: LayoutCatalogItem = {
  id: 'builtin:coding',
  source: 'builtin',
  name: 'Coding',
  slug: 'coding',
  type: 'coding',
  sourceIdentity: { id: 'builtin', kind: 'builtin' },
  contribution: {
    id: 'builtin:coding',
    version: '1.0.0',
    sourceIdentity: { id: 'builtin', kind: 'builtin' },
    provenance: { origin: 'builtin' },
  },
  lifecycle: {
    itemId: 'builtin:coding',
    state: 'installed',
    source: 'builtin',
  },
  visible: true,
  installable: false,
  enabled: true,
  policy: {},
};

const plugin: LayoutCatalogItem = {
  id: 'plugin:fixture:review',
  source: 'plugin',
  plugin: 'fixture',
  name: 'Review',
  slug: 'review',
  type: 'review',
  sourceIdentity: { id: 'fixture', kind: 'local', source: 'plugins/fixture' },
  contribution: {
    id: 'plugin:fixture:review',
    version: '1.2.3',
    sourceIdentity: { id: 'fixture', kind: 'local', source: 'plugins/fixture' },
    provenance: { origin: 'plugin', pluginId: 'fixture' },
  },
  lifecycle: {
    itemId: 'plugin:fixture:review',
    state: 'installed',
    source: 'fixture',
  },
  visible: true,
  installable: false,
  enabled: true,
  policy: {},
};

const secondPlugin: LayoutCatalogItem = {
  ...plugin,
  id: 'plugin:fixture-two:review',
  plugin: 'fixture-two',
  sourceIdentity: {
    id: 'fixture-two',
    kind: 'local',
    source: 'plugins/fixture-two',
  },
  contribution: {
    id: 'plugin:fixture-two:review',
    version: '2.0.0',
    sourceIdentity: {
      id: 'fixture-two',
      kind: 'local',
      source: 'plugins/fixture-two',
    },
    provenance: { origin: 'plugin', pluginId: 'fixture-two' },
  },
  lifecycle: {
    itemId: 'plugin:fixture-two:review',
    state: 'disabled',
    source: 'fixture-two',
  },
  enabled: false,
};

const builtinRendererPlugin: LayoutCatalogItem = {
  ...plugin,
  id: 'plugin:fixture-builtin-renderer:review',
  plugin: 'fixture-builtin-renderer',
  sourceIdentity: {
    id: 'fixture-builtin-renderer',
    kind: 'local',
    source: 'plugins/fixture-builtin-renderer',
  },
  contribution: {
    id: 'plugin:fixture-builtin-renderer:review',
    version: '3.0.0',
    sourceIdentity: {
      id: 'fixture-builtin-renderer',
      kind: 'local',
      source: 'plugins/fixture-builtin-renderer',
    },
    provenance: { origin: 'plugin', pluginId: 'fixture-builtin-renderer' },
  },
  lifecycle: {
    itemId: 'plugin:fixture-builtin-renderer:review',
    state: 'installed',
    source: 'fixture-builtin-renderer',
  },
};

const resolved = new Map<string, ResolvedCatalogLayout>([
  [
    builtin.id,
    {
      item: builtin,
      definition: { name: 'Coding', slug: 'coding', type: 'coding', tabs: [] },
    },
  ],
  [
    plugin.id,
    {
      item: plugin,
      pluginName: 'fixture',
      definition: {
        name: 'Review',
        slug: 'review',
        type: 'review',
        tabs: [
          {
            id: 'trusted',
            label: 'Trusted',
            component: { kind: 'plugin-component', name: 'review-queue' },
          },
          {
            id: 'sandboxed',
            label: 'Sandboxed',
            component: { kind: 'mcp-tool-ui', ref: 'fixture-mcp/issues' },
          },
        ],
      },
    },
  ],
  [
    secondPlugin.id,
    {
      item: secondPlugin,
      pluginName: 'fixture-two',
      definition: {
        name: 'Review',
        slug: 'review',
        type: 'review',
        tabs: [
          {
            id: 'sandboxed',
            label: 'Sandboxed',
            component: { kind: 'mcp-tool-ui', ref: 'fixture-mcp/issues' },
          },
        ],
      },
    },
  ],
  [
    builtinRendererPlugin.id,
    {
      item: builtinRendererPlugin,
      pluginName: 'fixture-builtin-renderer',
      definition: {
        name: 'Review',
        slug: 'review',
        type: 'review',
        tabs: [
          {
            id: 'shared',
            label: 'Shared Built-in',
            component: { kind: 'builtin-component', name: 'file-tree' },
          },
        ],
      },
    },
  ],
]);

function nestedInitialArguments(depth: number): Record<string, unknown> {
  let initialArguments: Record<string, unknown> = { value: 'leaf' };
  for (let index = 0; index < depth; index += 1) {
    initialArguments = { nested: initialArguments };
  }
  return initialArguments;
}

describe('current Workspace Pane catalog adapter', () => {
  test('rejects Proxy ingress data before any Proxy meta trap can run', () => {
    const metaTrapReads = {
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      has: 0,
      ownKeys: 0,
    };
    const hostileLayouts = new Proxy([builtin], {
      get: () => {
        metaTrapReads.get += 1;
        throw new Error('get trap must not run');
      },
      getOwnPropertyDescriptor: () => {
        metaTrapReads.getOwnPropertyDescriptor += 1;
        throw new Error('getOwnPropertyDescriptor trap must not run');
      },
      getPrototypeOf: () => {
        metaTrapReads.getPrototypeOf += 1;
        throw new Error('getPrototypeOf trap must not run');
      },
      has: () => {
        metaTrapReads.has += 1;
        throw new Error('has trap must not run');
      },
      ownKeys: () => {
        metaTrapReads.ownKeys += 1;
        throw new Error('ownKeys trap must not run');
      },
    });
    const catalogSource = {
      listLayouts: () => hostileLayouts,
      resolveForCatalog: () => {
        throw new Error('unsafe layouts must not be resolved');
      },
    } as unknown as DistributionProfileService;

    expect(() =>
      readCurrentWorkspacePaneCatalog(catalogSource, 'project-a'),
    ).toThrow('Workspace Pane catalog contains unsafe ingress data');
    expect(metaTrapReads).toEqual({
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      has: 0,
      ownKeys: 0,
    });
  });

  test('enumerates disabled contributions without applying them and retains plugin contribution for shared MCP renderers', () => {
    const catalogSource = {
      listLayouts: () => [plugin, secondPlugin, builtin],
      resolveForCatalog: (id: string) => resolved.get(id)!,
      resolveForApply: () => {
        throw new Error('catalog reads must not apply layouts');
      },
    } as unknown as DistributionProfileService;

    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
    );

    const placedDescriptorIds = new Set(
      snapshot.instances.map((instance) => instance.descriptorId),
    );
    const placedDescriptors = snapshot.descriptors.filter((descriptor) =>
      placedDescriptorIds.has(descriptor.id),
    );
    expect(placedDescriptors.map((entry) => entry.provenance)).toEqual(
      expect.arrayContaining([
        { origin: 'builtin' },
        {
          origin: 'plugin',
          pluginId: 'fixture-two',
          mcpServerId: 'fixture-mcp',
        },
        { origin: 'plugin', pluginId: 'fixture' },
        {
          origin: 'plugin',
          pluginId: 'fixture',
          mcpServerId: 'fixture-mcp',
        },
      ]),
    );
    expect(placedDescriptors.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('plugin%3Afixture:'),
        expect.stringContaining('plugin%3Afixture-two:'),
      ]),
    );
    expect(new Set(snapshot.descriptors.map((entry) => entry.id)).size).toBe(
      4 + knownDescriptorCount,
    );
    expect(snapshot.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: secondPlugin.id,
          lifecycle: expect.objectContaining({ state: 'disabled' }),
          enabled: false,
          disabledReason:
            'Disabled by distribution policy or lifecycle override',
        }),
      ]),
    );
    expect(snapshot.instances).toHaveLength(4 + knownInstanceFactoryCount);
    expect(snapshot.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptorId: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR.id,
          boundContext: {
            projectId: 'project-a',
            sourceId: 'builtin:workspace-coding-file-browser',
            workspaceId: 'project-a',
          },
        }),
        expect.objectContaining({
          descriptorId: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR.id,
          boundContext: {
            projectId: 'project-a',
            workspaceId: 'project-a',
            sourceId: 'builtin:workspace-coding-diff',
          },
        }),
        expect.objectContaining({
          descriptorId: WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR.id,
          boundContext: {
            projectId: 'project-a',
            sourceId: 'builtin:workspace-coding-terminal',
          },
        }),
        {
          version: '1.0',
          descriptorId: WORKSPACE_PLAN_PANE_DESCRIPTOR.id,
          instanceId: WORKSPACE_PLAN_PANE_INSTANCE_ID,
          stateKey: WORKSPACE_PLAN_PANE_INSTANCE_ID,
          boundContext: {
            projectId: 'project-a',
            workspaceId: 'project-a',
            sourceId: WORKSPACE_PLAN_PANE_SOURCE_ID,
          },
        },
        {
          version: '1.0',
          descriptorId: WORKSPACE_READINESS_PANE_DESCRIPTOR.id,
          instanceId: WORKSPACE_READINESS_PANE_INSTANCE_ID,
          stateKey: WORKSPACE_READINESS_PANE_INSTANCE_ID,
          boundContext: {
            projectId: 'project-a',
            workspaceId: 'project-a',
            sourceId: WORKSPACE_READINESS_PANE_SOURCE_ID,
          },
        },
        {
          version: '1.0',
          descriptorId: WORKSPACE_TRUST_PANE_DESCRIPTOR.id,
          instanceId: WORKSPACE_TRUST_PANE_INSTANCE_ID,
          stateKey: WORKSPACE_TRUST_PANE_INSTANCE_ID,
          boundContext: {
            projectId: 'project-a',
            workspaceId: 'project-a',
            sourceId: WORKSPACE_TRUST_PANE_SOURCE_ID,
          },
        },
        {
          version: '1.0',
          descriptorId: WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR.id,
          instanceId: 'workspace-spatial-board:project-a',
          stateKey: 'workspace-spatial-board:project-a',
          boundContext: {
            projectId: 'project-a',
            sourceId: WORKSPACE_SPATIAL_BOARD_PANE_SOURCE_ID,
          },
        },
      ]),
    );
    for (const [descriptor, instanceId] of [
      [WORKSPACE_PLAN_PANE_DESCRIPTOR, WORKSPACE_PLAN_PANE_INSTANCE_ID],
      [
        WORKSPACE_READINESS_PANE_DESCRIPTOR,
        WORKSPACE_READINESS_PANE_INSTANCE_ID,
      ],
      [WORKSPACE_TRUST_PANE_DESCRIPTOR, WORKSPACE_TRUST_PANE_INSTANCE_ID],
    ] as const) {
      expect(snapshot.descriptors).toContainEqual(descriptor);
      expect(
        snapshot.availability.find(
          (entry) =>
            entry.descriptorId === descriptor.id &&
            entry.instanceId === instanceId,
        ),
      ).toMatchObject({
        input: {
          rollout: 'available',
          distribution: 'enabled',
          renderer: 'unknown',
          context: { project: 'present' },
        },
        availability: {
          state: 'unsupported',
          reason: { code: 'renderer-unknown', source: 'renderer' },
        },
      });
    }
    expect(snapshot.availability).toHaveLength(4 + knownDescriptorCount);
    const builtinDescriptor = placedDescriptors.find(
      (entry) => entry.provenance.origin === 'builtin',
    )!;
    const builtinAvailability = snapshot.availability.find(
      (entry) => entry.descriptorId === builtinDescriptor.id,
    )!;
    expect(builtinAvailability.input).toEqual({
      rollout: 'available',
      distribution: 'enabled',
      renderer: 'unknown',
      context: { project: 'present' },
    });
    expect(
      resolveWorkspacePaneAvailability(
        { ...builtinAvailability.input, renderer: 'present' },
        builtinDescriptor.modes[0].contextRequirement,
      ),
    ).toMatchObject({ state: 'available', reason: { code: 'ready' } });
    expect(snapshot.availability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availability: {
            state: 'not-configured',
            reason: {
              code: 'distribution-disabled',
              source: 'distribution-policy',
            },
            action: { type: 'setup', code: 'enable-distribution' },
          },
        }),
      ]),
    );
    expect(
      snapshot.instances.every(
        (entry) => entry.boundContext?.projectId === 'project-a',
      ),
    ).toBe(true);
    const layoutDerivedInstances = snapshot.instances.filter((entry) =>
      entry.descriptorId.includes('fixture'),
    );
    expect(
      layoutDerivedInstances.every(
        (entry) => entry.boundContext?.contribution?.id,
      ),
    ).toBe(true);
    expect(
      layoutDerivedInstances.map((entry) => entry.boundContext?.contribution),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin:fixture:review',
          version: '1.2.3',
          provenance: { origin: 'plugin', pluginId: 'fixture' },
        }),
      ]),
    );
    const knownEntries = snapshot.availability.filter(
      (entry) => entry.instanceId === undefined,
    );
    expect(knownEntries).toHaveLength(
      knownDescriptorCount - knownInstanceFactoryCount,
    );
    const filePreviewEntry = knownEntries.find(
      (entry) =>
        entry.descriptorId === WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.id,
    );
    expect(filePreviewEntry).toMatchObject({
      input: {
        rollout: 'available',
        distribution: 'enabled',
        renderer: 'unknown',
        context: { project: 'present' },
      },
      availability: {
        state: 'unsupported',
        reason: { code: 'renderer-unknown', source: 'renderer' },
      },
    });
    const browserPreviewEntry = knownEntries.find(
      (entry) =>
        entry.descriptorId === WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.id,
    );
    expect(browserPreviewEntry).toMatchObject({
      input: {
        rollout: 'available',
        distribution: 'enabled',
        renderer: 'unknown',
        context: { project: 'present' },
        requirements: {
          hostCapabilities: ['local-browser-preview'],
          configuration: true,
        },
      },
      availability: {
        state: 'unsupported',
        reason: { code: 'host-capability-unknown', source: 'native-host' },
      },
    });
    expect(
      knownEntries.find(
        (entry) =>
          entry.descriptorId ===
          'pane:builtin:workspace-preview:flow-run-console',
      ),
    ).toMatchObject({
      input: { rollout: 'coming-soon' },
      availability: {
        state: 'coming-soon',
        reason: { code: 'coming-soon', source: 'product-rollout' },
      },
    });
  });

  test('issues the builtin Coding occurrence with the source identity required by its renderer gate', () => {
    const catalogSource = {
      listLayouts: () => [builtin],
      resolveForCatalog: (id: string) => resolved.get(id)!,
    } as unknown as DistributionProfileService;
    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
    );
    const coding = snapshot.instances.find(
      (instance) => instance.descriptorId === 'pane:builtin:coding:coding',
    );
    expect(coding).toBeDefined();
    expect(coding?.boundContext).toMatchObject({
      projectId: 'project-a',
      sourceId: 'builtin:coding',
    });
  });

  test('projects a direct plugin Pane declaration without invoking the Layout adapter', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      version: '1.0',
      id: 'review-plugin-pane',
      name: 'Review Plugin Pane',
      rendererId: 'review-plugin.review',
      renderer: { kind: 'plugin-component', name: 'review' },
      placement: { supportedRegions: ['primary'] },
      modes: [{ id: 'default', contextRequirement: { project: true } }],
      provenance: { origin: 'plugin', pluginId: 'review-plugin' },
      lifecycle: { stage: 'stable' },
    })!;
    const contribution = {
      id: 'plugin:review-plugin:pane-0123456789ab',
      version: '1.2.3',
      sourceIdentity: {
        id: 'review-plugin',
        kind: 'local' as const,
        source: 'plugins/review-plugin',
      },
      provenance: { origin: 'plugin' as const, pluginId: 'review-plugin' },
    };
    const catalogSource = {
      listLayouts: () => [],
      listPluginWorkspacePaneContributions: () => [
        {
          id: contribution.id,
          pluginName: 'review-plugin',
          enabled: true as const,
          descriptor,
          contribution,
        },
      ],
      resolveForCatalog: () => {
        throw new Error('direct Pane declarations must not resolve a Layout');
      },
    } as unknown as DistributionProfileService;

    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
    );
    expect(snapshot.descriptors).toContainEqual(descriptor);
    // station#3543: the declaration receives one server-issued occurrence
    // whose binding is the distribution service's on-disk contribution
    // snapshot — the fact the renderer trust check evaluates.
    const instances = snapshot.instances.filter(
      (instance) => instance.descriptorId === descriptor.id,
    );
    expect(instances).toEqual([
      expect.objectContaining({
        descriptorId: descriptor.id,
        instanceId: `instance:plugin:project-a:${contribution.id}`,
        stateKey: `state:plugin:project-a:${contribution.id}`,
        boundContext: { projectId: 'project-a', contribution },
      }),
    ]);
    expect(snapshot.availability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptorId: descriptor.id,
          instanceId: instances[0].instanceId,
          input: expect.objectContaining({
            distribution: 'enabled',
            renderer: 'unknown',
            context: expect.objectContaining({ project: 'present' }),
          }),
        }),
      ]),
    );
  });

  test('a disabled direct plugin Pane keeps its occurrence while availability reports the distribution fact', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      version: '1.0',
      id: 'review-plugin-pane',
      name: 'Review Plugin Pane',
      rendererId: 'review-plugin.review',
      renderer: { kind: 'plugin-component', name: 'review' },
      placement: { supportedRegions: ['primary'] },
      modes: [{ id: 'default', contextRequirement: { project: true } }],
      provenance: { origin: 'plugin', pluginId: 'review-plugin' },
      lifecycle: { stage: 'stable' },
    })!;
    const contribution = {
      id: 'plugin:review-plugin:pane-0123456789ab',
      version: '1.2.3',
      sourceIdentity: {
        id: 'review-plugin',
        kind: 'local' as const,
        source: 'plugins/review-plugin',
      },
      provenance: { origin: 'plugin' as const, pluginId: 'review-plugin' },
    };
    const catalogSource = {
      listLayouts: () => [],
      listPluginWorkspacePaneContributions: () => [
        {
          id: contribution.id,
          pluginName: 'review-plugin',
          enabled: false as const,
          descriptor,
          contribution,
        },
      ],
      resolveForCatalog: () => {
        throw new Error('direct Pane declarations must not resolve a Layout');
      },
    } as unknown as DistributionProfileService;

    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
    );
    expect(snapshot.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ descriptorId: descriptor.id }),
      ]),
    );
    expect(snapshot.availability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptorId: descriptor.id,
          input: expect.objectContaining({ distribution: 'disabled' }),
        }),
      ]),
    );
  });

  test('a direct plugin contribution without an issuance snapshot yields no occurrence', () => {
    const descriptor = parseWorkspacePaneDescriptor({
      version: '1.0',
      id: 'review-plugin-pane',
      name: 'Review Plugin Pane',
      rendererId: 'review-plugin.review',
      renderer: { kind: 'plugin-component', name: 'review' },
      placement: { supportedRegions: ['primary'] },
      modes: [{ id: 'default', contextRequirement: { project: true } }],
      provenance: { origin: 'plugin', pluginId: 'review-plugin' },
      lifecycle: { stage: 'stable' },
    })!;
    const catalogSource = {
      listLayouts: () => [],
      // An older catalog source shape: descriptor present, no on-disk
      // contribution snapshot. Issuing an unattributed occurrence would be
      // worse than issuing none — no renderer trust check could bind it.
      listPluginWorkspacePaneContributions: () => [
        {
          id: descriptor.id,
          pluginName: 'review-plugin',
          enabled: true as const,
          descriptor,
        },
      ],
      resolveForCatalog: () => {
        throw new Error('direct Pane declarations must not resolve a Layout');
      },
    } as unknown as DistributionProfileService;

    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
    );
    expect(snapshot.descriptors).toContainEqual(descriptor);
    expect(snapshot.instances).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ descriptorId: descriptor.id }),
      ]),
    );
  });

  test('direct declaration can preserve the descriptor produced by the legacy Layout bridge', () => {
    const legacySource = {
      listLayouts: () => [plugin],
      resolveForCatalog: (id: string) => resolved.get(id)!,
    } as unknown as DistributionProfileService;
    const legacy = readCurrentWorkspacePaneCatalog(legacySource, 'project-a');
    const bridged = legacy.descriptors.find(
      (descriptor) => descriptor.provenance.origin === 'plugin',
    )!;
    const directSource = {
      listLayouts: () => [],
      listPluginWorkspacePaneContributions: () => [
        {
          id: bridged.id,
          pluginName: 'fixture',
          enabled: true as const,
          descriptor: bridged,
        },
      ],
      resolveForCatalog: () => {
        throw new Error('direct declaration must not read a Layout');
      },
    } as unknown as DistributionProfileService;
    const direct = readCurrentWorkspacePaneCatalog(directSource, 'project-a');
    expect(direct.descriptors).toContainEqual(bridged);
  });

  test('attributes a plugin-contributed built-in renderer to its plugin', () => {
    const catalogSource = {
      listLayouts: () => [builtinRendererPlugin],
      resolveForCatalog: (id: string) => resolved.get(id)!,
    } as unknown as DistributionProfileService;

    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
    );

    expect(snapshot.descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'pane:plugin%3Afixture-builtin-renderer:review:shared',
          renderer: { kind: 'builtin-component', name: 'file-tree' },
          provenance: {
            origin: 'plugin',
            pluginId: 'fixture-builtin-renderer',
          },
        }),
      ]),
    );
    expect(snapshot.descriptors).toHaveLength(1 + knownDescriptorCount);
  });

  test('keeps Files and Diff disabled until the catalog receives authoritative workspace and Git facts', () => {
    const catalogSource = {
      listLayouts: () => [builtin],
      resolveForCatalog: (id: string) => resolved.get(id)!,
    } as unknown as DistributionProfileService;
    const directPaneInput = (
      workspace: 'present' | 'missing',
      gitRepository?: 'present' | 'missing',
    ) => ({
      resolveInput: ({ descriptor }: { descriptor: { id: string } }) =>
        descriptor.id === WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR.id ||
        descriptor.id === WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR.id
          ? {
              renderer: 'present' as const,
              context: {
                workspace,
                ...(gitRepository ? { gitRepository } : {}),
              },
            }
          : {},
    });
    const find = (
      snapshot: ReturnType<typeof readCurrentWorkspacePaneCatalog>,
      descriptorId: string,
    ) =>
      snapshot.availability.find(
        (entry) => entry.descriptorId === descriptorId,
      )!;

    const withoutWorkspace = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
      directPaneInput('missing'),
    );
    expect(
      find(withoutWorkspace, WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR.id)
        .availability,
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'missing-workspace', source: 'context' },
      action: { type: 'setup', code: 'select-workspace' },
    });
    expect(
      find(withoutWorkspace, WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR.id)
        .availability,
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'missing-workspace', source: 'context' },
    });

    const withoutGitRepository = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
      directPaneInput('present', 'missing'),
    );
    expect(
      find(
        withoutGitRepository,
        WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR.id,
      ).availability,
    ).toMatchObject({ state: 'available', reason: { code: 'ready' } });
    expect(
      find(withoutGitRepository, WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR.id)
        .availability,
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'missing-git-repository', source: 'context' },
      action: { type: 'setup', code: 'select-git-repository' },
    });

    const ready = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
      directPaneInput('present', 'present'),
    );
    expect(
      find(ready, WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR.id).availability,
    ).toMatchObject({ state: 'available', reason: { code: 'ready' } });
  });

  test('keeps depth-32 MCP arguments in the catalog and rejects depth 33', () => {
    const depthPlugin: LayoutCatalogItem = {
      ...plugin,
      id: 'plugin:fixture:depth-boundary',
      contribution: {
        ...plugin.contribution,
        id: 'plugin:fixture:depth-boundary',
      },
    };
    const catalogAtDepth = (depth: number) =>
      ({
        listLayouts: () => [depthPlugin],
        resolveForCatalog: () => ({
          item: depthPlugin,
          pluginName: 'fixture',
          definition: {
            name: 'Depth boundary',
            slug: 'depth-boundary',
            type: 'review',
            tabs: [
              {
                id: 'mcp-depth',
                label: 'MCP depth',
                component: {
                  kind: 'mcp-tool-ui',
                  ref: 'fixture-mcp/depth',
                  initialArguments: nestedInitialArguments(depth),
                },
              },
            ],
          },
        }),
      }) as unknown as DistributionProfileService;

    expect(
      readCurrentWorkspacePaneCatalog(catalogAtDepth(32), 'project-a')
        .descriptors,
    ).toHaveLength(1 + knownDescriptorCount);
    expect(() =>
      readCurrentWorkspacePaneCatalog(catalogAtDepth(33), 'project-a'),
    ).toThrow(/invalid Pane adaptation/);
  });

  test('adapts valid maximum-length project and source IDs without making the composed scope oversized', () => {
    const maxProjectId = 'p'.repeat(128);
    const maxSourceId = 's'.repeat(128);
    const longIdBuiltin: LayoutCatalogItem = {
      ...builtin,
      id: maxSourceId,
      contribution: { ...builtin.contribution, id: maxSourceId },
      lifecycle: {
        itemId: maxSourceId,
        state: 'installed',
        source: 'builtin',
      },
    };
    const catalogSource = {
      listLayouts: () => [longIdBuiltin],
      resolveForCatalog: () => ({
        item: longIdBuiltin,
        definition: {
          name: 'Coding',
          slug: 'coding',
          type: 'coding',
          tabs: [],
        },
      }),
    } as unknown as DistributionProfileService;

    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      maxProjectId,
    );

    expect(snapshot.instances).toHaveLength(1 + knownInstanceFactoryCount);
    // The subject is the hashed-scope instance this case authors, selected by
    // IDENTITY: built-in instances share the array, so a positional pick
    // silently retargets the assertion (station#2221).
    const scoped = snapshot.instances.find((instance) =>
      /^instance:scope-h1-/.test(instance.instanceId),
    );
    expect(scoped?.instanceId).toMatch(
      /^instance:scope-h1-[1-9a-z][0-9a-z]*-[0-9a-f]{16}:/,
    );
    expect(scoped?.stateKey).toMatch(
      /^state:scope-h1-[1-9a-z][0-9a-z]*-[0-9a-f]{16}:/,
    );
  });

  test('normalizes empty baseline tab decorations instead of failing the read-only catalog', () => {
    const emptyDecorationBuiltin: LayoutCatalogItem = {
      ...builtin,
      id: 'builtin:empty-decorations',
      contribution: {
        ...builtin.contribution,
        id: 'builtin:empty-decorations',
      },
      lifecycle: {
        itemId: 'builtin:empty-decorations',
        state: 'installed',
        source: 'builtin',
      },
    };
    const catalogSource = {
      listLayouts: () => [emptyDecorationBuiltin],
      resolveForCatalog: () => ({
        item: emptyDecorationBuiltin,
        definition: {
          name: 'Empty decorations',
          slug: 'empty-decorations',
          type: 'coding',
          tabs: [
            {
              id: 'files',
              label: 'Files',
              component: { kind: 'builtin-component', name: 'file-tree' },
              icon: '',
              description: '',
            },
          ],
        },
      }),
    } as unknown as DistributionProfileService;

    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
    );

    const adaptedDescriptor = snapshot.descriptors.find((descriptor) =>
      descriptor.id.includes('empty-decorations'),
    );
    expect(snapshot.descriptors).toHaveLength(1 + knownDescriptorCount);
    expect(adaptedDescriptor).not.toHaveProperty('icon');
    expect(adaptedDescriptor).not.toHaveProperty('description');
  });
});

describe('a layout this project does not offer contributes no Pane (station#3778)', () => {
  const sessionBoard: LayoutCatalogItem = {
    ...builtin,
    id: 'builtin:session-board',
    name: 'Session Board',
    slug: 'session-board',
    type: 'session-board',
    contribution: {
      id: 'builtin:session-board',
      version: '1.0.0',
      sourceIdentity: { id: 'builtin', kind: 'builtin' },
      provenance: { origin: 'builtin' },
    },
    lifecycle: {
      itemId: 'builtin:session-board',
      state: 'installed',
      source: 'builtin',
    },
  };
  const resolvedWithBoard = new Map(resolved);
  resolvedWithBoard.set(sessionBoard.id, {
    item: sessionBoard,
    definition: {
      name: 'Session Board',
      slug: 'session-board',
      type: 'session-board',
      tabs: [],
    },
  });
  const catalogSource = {
    listLayouts: () => [builtin, sessionBoard],
    resolveForCatalog: (id: string) => resolvedWithBoard.get(id)!,
  } as unknown as DistributionProfileService;

  const boardPaneIds = (snapshot: {
    descriptors: readonly { id: string }[];
    availability: readonly { descriptorId: string }[];
  }) => ({
    descriptors: snapshot.descriptors
      .map((descriptor) => descriptor.id)
      .filter((id) => id.includes('session-board')),
    availability: snapshot.availability
      .map((entry) => entry.descriptorId)
      .filter((id) => id.includes('session-board')),
  });

  test('offered: a layout that IS a Pane contributes one', () => {
    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
      undefined,
      [],
      { offersLayout: () => true },
    );

    // #3778's property, restated against a layout this build renders: an
    // offer-everything predicate removes nothing. It used to be stated with
    // the Board, which station#3798 established is not a Pane at all — see
    // the test below.
    expect(
      snapshot.descriptors.some((descriptor) =>
        descriptor.id.includes('builtin:coding'),
      ),
    ).toBe(true);
  });

  test('a builtin layout with no Pane renderer contributes none even when offered (station#3798)', () => {
    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
      undefined,
      [],
      { offersLayout: () => true },
    );

    // The Board is reached as a route; `session-board` is not in the build's
    // Pane renderer inventory and never will be. Advertising it made the
    // client explain a missing renderer as "Temporarily unavailable" — a
    // transient sentence, with a Retry that cannot help, for a permanent
    // structural fact. Omission is the same shape #3778 chose above.
    expect(boardPaneIds(snapshot)).toEqual({
      descriptors: [],
      availability: [],
    });
    expect(
      snapshot.instances.filter((instance) =>
        instance.descriptorId.includes('session-board'),
      ),
    ).toEqual([]);
    // Still installed, and the catalogue still says so.
    expect(
      snapshot.contributions.map((contribution) => contribution.id),
    ).toContain('builtin:session-board');
  });

  test('not offered: no descriptor, no instance, no availability entry', () => {
    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
      undefined,
      [],
      { offersLayout: (layout) => layout.type !== 'session-board' },
    );

    // A card explaining a Pane whose subject does not exist here is the defect:
    // the nav entry and the route guard simply omit the Board, and so does this.
    expect(boardPaneIds(snapshot)).toEqual({
      descriptors: [],
      availability: [],
    });
    expect(
      snapshot.instances.filter((instance) =>
        instance.descriptorId.includes('session-board'),
      ),
    ).toEqual([]);
    // The layout is still INSTALLED, and the catalogue still says so.
    expect(
      snapshot.contributions.map((contribution) => contribution.id),
    ).toContain('builtin:session-board');
  });

  test('the other layouts are untouched by the omission', () => {
    const snapshot = readCurrentWorkspacePaneCatalog(
      catalogSource,
      'project-a',
      undefined,
      [],
      { offersLayout: (layout) => layout.type !== 'session-board' },
    );

    expect(
      snapshot.descriptors.some((descriptor) =>
        descriptor.id.includes('builtin:coding'),
      ),
    ).toBe(true);
  });
});
