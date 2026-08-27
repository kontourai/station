import { describe, expect, test } from 'vitest';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '../workspace-pane';
import { parseWorkspacePaneDescriptor } from '../workspace-pane';
import {
  createWorkspacePaneCatalog,
  createWorkspacePaneCatalogFromAdaptations,
  enumerateLayoutDefinitionPanes,
  type WorkspacePaneLayoutTabAdaptation,
} from '../workspace-pane-layout-adapter';
import {
  adapt,
  builtinTab,
  context,
  mcpTab,
  pluginTab,
} from './workspace-pane-layout-adapter.test-fixtures';

describe('workspace pane catalog', () => {
  function catalogFixtures(): WorkspacePaneLayoutTabAdaptation[] {
    const adaptations = enumerateLayoutDefinitionPanes(
      {
        slug: 'synthetic-layout',
        tabs: [builtinTab(), pluginTab(), mcpTab()],
      },
      context({ pluginId: 'synthetic-plugin' }),
    );
    return adaptations as WorkspacePaneLayoutTabAdaptation[];
  }

  test('lists descriptors deterministically regardless of construction order', () => {
    const adaptations = catalogFixtures();
    const forward = createWorkspacePaneCatalogFromAdaptations(adaptations);
    const reversed = createWorkspacePaneCatalogFromAdaptations(
      [...adaptations].reverse(),
    );

    expect(forward.list()).toEqual(reversed.list());
    expect(forward.list().map((d) => d.id)).toEqual([
      'pane:plugin%3Asynthetic-plugin:synthetic-layout:files',
      'pane:plugin%3Asynthetic-plugin:synthetic-layout:review-queue',
      'pane:plugin%3Asynthetic-plugin:synthetic-layout:issue-ui',
    ]);
    expect(forward.listDescriptors()).toEqual(forward.list());
    expect(forward.listInstances()).toEqual(reversed.listInstances());
  });

  test('looks descriptors and instances up by id', () => {
    const catalog = createWorkspacePaneCatalogFromAdaptations(
      catalogFixtures(),
    );

    expect(catalog.size).toBe(3);
    expect(catalog.instanceCount).toBe(3);
    expect(
      catalog.has('pane:plugin%3Asynthetic-plugin:synthetic-layout:files'),
    ).toBe(true);
    expect(
      catalog.has('pane:plugin%3Asynthetic-plugin:synthetic-layout:missing'),
    ).toBe(false);
    expect(
      catalog.get('pane:plugin%3Asynthetic-plugin:synthetic-layout:files')
        ?.name,
    ).toBe('Files');
    expect(
      catalog.get('pane:plugin%3Asynthetic-plugin:synthetic-layout:missing'),
    ).toBeUndefined();
    expect(
      catalog.getInstance(
        'instance:synthetic-layout:pane:plugin%3Asynthetic-plugin:synthetic-layout:issue-ui',
      )?.descriptorId,
    ).toBe('pane:plugin%3Asynthetic-plugin:synthetic-layout:issue-ui');
    expect(catalog.getInstance('instance:nope')).toBeUndefined();
  });

  test('preserves each descriptor’s declared provenance', () => {
    const catalog = createWorkspacePaneCatalogFromAdaptations(
      catalogFixtures(),
    );

    expect(catalog.list().map((d) => d.provenance)).toEqual([
      { origin: 'plugin', pluginId: 'synthetic-plugin' },
      { origin: 'plugin', pluginId: 'synthetic-plugin' },
      {
        origin: 'plugin',
        pluginId: 'synthetic-plugin',
        mcpServerId: 'synthetic-server',
      },
    ]);
  });

  test('narrows instances to one descriptor', () => {
    const adaptations = catalogFixtures();
    const [files] = adaptations;
    const extraPlacement: WorkspacePaneInstance = {
      ...files.instance,
      instanceId:
        'instance:window-b:pane:plugin%3Asynthetic-plugin:synthetic-layout:files' as WorkspacePaneInstance['instanceId'],
      stateKey:
        'state:window-b:pane:plugin%3Asynthetic-plugin:synthetic-layout:files' as WorkspacePaneInstance['stateKey'],
    };
    const catalog = createWorkspacePaneCatalog({
      descriptors: adaptations.map((a) => a.descriptor),
      instances: [...adaptations.map((a) => a.instance), extraPlacement],
    });

    expect(
      catalog
        .listInstances('pane:plugin%3Asynthetic-plugin:synthetic-layout:files')
        .map((i) => i.instanceId),
    ).toEqual([
      'instance:synthetic-layout:pane:plugin%3Asynthetic-plugin:synthetic-layout:files',
      'instance:window-b:pane:plugin%3Asynthetic-plugin:synthetic-layout:files',
    ]);
    expect(
      catalog.listInstances(
        'pane:plugin%3Asynthetic-plugin:synthetic-layout:missing',
      ),
    ).toEqual([]);
  });

  test('rejects duplicate descriptor ids instead of shadowing one contributor with another', () => {
    const [files] = catalogFixtures();
    const shadow: WorkspacePaneDescriptor = {
      ...files.descriptor,
      name: 'Shadowed',
    };

    expect(() =>
      createWorkspacePaneCatalog({ descriptors: [files.descriptor, shadow] }),
    ).toThrow(/Duplicate workspace pane descriptor id/);
  });

  test('deduplicates identical descriptors across independent instance scopes', () => {
    const first = adapt(builtinTab(), {
      layoutSlug: 'shared-layout',
      instanceScope: 'project:one:source:builtin',
    });
    const second = adapt(builtinTab(), {
      layoutSlug: 'shared-layout',
      instanceScope: 'project:two:source:builtin',
    });

    const catalog = createWorkspacePaneCatalogFromAdaptations([first, second]);

    expect(catalog.size).toBe(1);
    expect(catalog.instanceCount).toBe(2);
    expect(
      catalog.listInstances().map((instance) => instance.stateKey),
    ).toEqual([first.instance.stateKey, second.instance.stateKey]);
  });

  test('keeps plugin-contributed built-in panes distinct when layouts and tab identities overlap', () => {
    const sharedTab = builtinTab();
    const first = adapt(sharedTab, {
      layoutSlug: 'shared-layout',
      instanceScope: 'project:one:source:plugin-one',
      pluginId: 'plugin-one',
    });
    const second = adapt(sharedTab, {
      layoutSlug: 'shared-layout',
      instanceScope: 'project:two:source:plugin-two',
      pluginId: 'plugin-two',
    });
    const differentlyLabeled = adapt(
      { ...sharedTab, label: 'Different Files' },
      {
        layoutSlug: 'shared-layout',
        instanceScope: 'project:three:source:plugin-three',
        pluginId: 'plugin-three',
      },
    );

    const catalog = createWorkspacePaneCatalogFromAdaptations([
      first,
      second,
      differentlyLabeled,
    ]);

    expect(catalog.size).toBe(3);
    expect(catalog.instanceCount).toBe(3);
    expect(catalog.list().map((descriptor) => descriptor.provenance)).toEqual([
      { origin: 'plugin', pluginId: 'plugin-one' },
      { origin: 'plugin', pluginId: 'plugin-three' },
      { origin: 'plugin', pluginId: 'plugin-two' },
    ]);
    expect(catalog.list().map((descriptor) => descriptor.id)).toEqual([
      'pane:plugin%3Aplugin-one:shared-layout:files',
      'pane:plugin%3Aplugin-three:shared-layout:files',
      'pane:plugin%3Aplugin-two:shared-layout:files',
    ]);
    expect(catalog.list().map((descriptor) => descriptor.name)).toEqual([
      'Files',
      'Different Files',
      'Files',
    ]);
    expect(
      catalog.listInstances().map((instance) => instance.descriptorId),
    ).toEqual(catalog.list().map((descriptor) => descriptor.id));
  });

  test('rejects same-id adaptations when their definition or security provenance conflicts', () => {
    const first = adapt(builtinTab(), {
      layoutSlug: 'shared-layout',
      instanceScope: 'project:one:source:builtin',
    });
    const conflictingDefinition = {
      ...adapt(builtinTab(), {
        layoutSlug: 'shared-layout',
        instanceScope: 'project:two:source:builtin',
      }),
      descriptor: { ...first.descriptor, name: 'Conflicting Files' },
    } as WorkspacePaneLayoutTabAdaptation;
    const conflictingSecurity = {
      ...adapt(builtinTab(), {
        layoutSlug: 'shared-layout',
        instanceScope: 'project:three:source:plugin',
      }),
      descriptor: {
        ...first.descriptor,
        rendererId: 'renderer:plugin:plugin-component:plugin-files',
        renderer: { kind: 'plugin-component', name: 'plugin-files' },
        provenance: { origin: 'plugin', pluginId: 'files-plugin' },
      },
    } as WorkspacePaneLayoutTabAdaptation;

    expect(() =>
      createWorkspacePaneCatalogFromAdaptations([first, conflictingDefinition]),
    ).toThrow(/Duplicate workspace pane descriptor id/);
    expect(() =>
      createWorkspacePaneCatalogFromAdaptations([first, conflictingSecurity]),
    ).toThrow(/Duplicate workspace pane descriptor id/);
  });

  test('keeps an accepted maximum-depth MCP initialArguments payload through catalog freezing', () => {
    let initialArguments: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 32; i += 1) {
      initialArguments = { nested: initialArguments };
    }
    const descriptor = parseWorkspacePaneDescriptor({
      version: '1.0',
      id: 'depth-boundary',
      name: 'Depth Boundary',
      rendererId: 'depth-boundary-renderer',
      renderer: {
        kind: 'mcp-tool-ui',
        ref: 'github/create_issue',
        initialArguments,
      },
      placement: { supportedRegions: ['standalone'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'mcp', mcpServerId: 'github' },
      lifecycle: { stage: 'stable' },
    });

    expect(descriptor).not.toBeNull();
    expect(() =>
      createWorkspacePaneCatalog({ descriptors: [descriptor!] }),
    ).not.toThrow();
  });

  test('rejects duplicate instance ids', () => {
    const [files] = catalogFixtures();

    expect(() =>
      createWorkspacePaneCatalog({
        descriptors: [files.descriptor],
        instances: [files.instance, { ...files.instance }],
      }),
    ).toThrow(/Duplicate workspace pane instance id/);
  });

  test('rejects an instance referencing a descriptor the catalog does not hold', () => {
    const [files, review] = catalogFixtures();

    expect(() =>
      createWorkspacePaneCatalog({
        descriptors: [files.descriptor],
        instances: [review.instance],
      }),
    ).toThrow(/references unknown descriptor/);
  });

  test('rejects a descriptor whose version was forged past the contract parser', () => {
    const [files] = catalogFixtures();
    const forged = {
      ...files.descriptor,
      version: '2.0',
    } as unknown as WorkspacePaneDescriptor;

    expect(() => createWorkspacePaneCatalog({ descriptors: [forged] })).toThrow(
      TypeError,
    );
  });

  test('rejects a descriptor whose provenance carries MCP attribution for a built-in renderer', () => {
    const [files] = catalogFixtures();
    const forged: WorkspacePaneDescriptor = {
      ...files.descriptor,
      provenance: {
        origin: 'plugin',
        pluginId: 'spoofed',
        mcpServerId: 'not-a-mcp-renderer',
      },
    };

    expect(() => createWorkspacePaneCatalog({ descriptors: [forged] })).toThrow(
      TypeError,
    );
  });

  test('rejects an instance whose version was forged past the contract parser', () => {
    const [files] = catalogFixtures();
    const forged = {
      ...files.instance,
      version: '2.0',
    } as unknown as WorkspacePaneInstance;

    expect(() =>
      createWorkspacePaneCatalog({
        descriptors: [files.descriptor],
        instances: [forged],
      }),
    ).toThrow(TypeError);
  });

  test('rejects a duplicate state key across independently placed instances', () => {
    const [files] = catalogFixtures();
    const duplicateStateKey: WorkspacePaneInstance = {
      ...files.instance,
      instanceId:
        `${files.instance.instanceId}-again` as WorkspacePaneInstance['instanceId'],
    };

    expect(() =>
      createWorkspacePaneCatalog({
        descriptors: [files.descriptor],
        instances: [files.instance, duplicateStateKey],
      }),
    ).toThrow(/Duplicate workspace pane instance state key/);
  });

  test('is read-only: stored entries are frozen and isolated from later mutation', () => {
    const adaptations = catalogFixtures();
    const catalog = createWorkspacePaneCatalogFromAdaptations(adaptations);
    const stored = catalog.get(
      'pane:plugin%3Asynthetic-plugin:synthetic-layout:files',
    ) as WorkspacePaneDescriptor;

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.provenance)).toBe(true);
    expect(Object.isFrozen(catalog.list())).toBe(true);

    adaptations[0].descriptor.provenance.pluginId = 'injected';
    expect(
      catalog.get('pane:plugin%3Asynthetic-plugin:synthetic-layout:files')
        ?.provenance,
    ).toEqual({
      origin: 'plugin',
      pluginId: 'synthetic-plugin',
    });
  });

  test('holds an empty catalog without instances', () => {
    const catalog = createWorkspacePaneCatalog({ descriptors: [] });
    expect(catalog.size).toBe(0);
    expect(catalog.instanceCount).toBe(0);
    expect(catalog.list()).toEqual([]);
    expect(catalog.listInstances()).toEqual([]);
  });
});
