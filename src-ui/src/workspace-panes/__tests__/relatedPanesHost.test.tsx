/** @vitest-environment jsdom */

/**
 * The related-pane capability a plugin occurrence is given
 * (`PaneRelatedPanesHost`, docs/design/pane-relationships.md), through the
 * real hook a direct pane's SDK boundary and a frame's transport both call:
 * the real navigation store, region model, relations owner (with exclusive
 * locks) and Station fence. Only the Project's pane catalog, the dock's
 * Project and the plugin registry's admission are stubbed — the facts the
 * host admits against, which each test sets.
 */

import type { LayoutCatalogContribution } from '@kontourai/station-contracts/layout';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type {
  PaneRelatedPanesHost,
  RelatedPaneOpenRequest,
} from '@kontourai/station-contracts/workspace-pane-host-contract';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pluginRelatedPaneBudget } from '../../components/plugins/plugin-frame-budget';
import {
  type Authority,
  AuthorityHarness,
  installFakeLocks,
  removeLocks,
  settledStorageSnapshot,
} from '../../contexts/__tests__/paneRelationsHarness';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  PaneRelationsProvider,
  type PaneRelationsValue,
  usePaneRelations,
} from '../../contexts/PaneRelationsContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { readPaneFence } from '../../regions/pane-fence';
import {
  PANE_RELATIONS_STORAGE_KEY,
  parsePaneRelations,
} from '../../regions/pane-relations';
import { readPluginPaneState } from '../pluginPaneOccurrence';
import {
  type RelatedPaneCaller,
  relatedPaneCaller,
  useRelatedPanesHost,
} from '../relatedPanesHost';
import type { ResolvedWorkspacePaneCatalogEntry } from '../resolvedWorkspacePaneCatalog';

const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };

function contribution(version = '1.0.0'): LayoutCatalogContribution {
  return {
    id: 'plugin:reports',
    version,
    sourceIdentity: { kind: 'local', id: 'reports', source: 'plugins/reports' },
    provenance: { origin: 'plugin', pluginId: 'reports' },
  } as LayoutCatalogContribution;
}

function descriptor(
  name: string,
  extra: Record<string, unknown> = {},
  pluginId = 'reports',
): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor({
    version: '1.0',
    id: `pane:plugin%3A${pluginId}:${name}`,
    name,
    rendererId: `renderer:plugin%3A${pluginId}:plugin-component:${name}`,
    renderer: { kind: 'plugin-component', name },
    placement: { supportedRegions: ['primary'], preferredRegion: 'primary' },
    modes: [
      { id: 'project', contextRequirement: { project: true } },
      { id: 'task', contextRequirement: { project: true, task: true } },
    ],
    provenance: { origin: 'plugin', pluginId },
    lifecycle: { stage: 'stable' },
    ...extra,
  });
  if (!parsed) throw new Error(`invalid fixture descriptor ${name}`);
  return parsed;
}

const LIST = descriptor('list');
const DETAIL = descriptor('detail');
const TOOL = descriptor('tool', { relationRole: 'tool' });
const FOREIGN = descriptor('foreign', {}, 'other');

function entryOf(
  paneDescriptor: WorkspacePaneDescriptor,
  version = '1.0.0',
): ResolvedWorkspacePaneCatalogEntry {
  const pluginId = paneDescriptor.provenance.pluginId as string;
  const instance = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: paneDescriptor.id,
    instanceId: `instance:plugin:${PROJECT.projectId}:${paneDescriptor.id}`,
    stateKey: `state:plugin:${PROJECT.projectId}:${paneDescriptor.id}`,
    boundContext: {
      projectId: PROJECT.projectId,
      contribution:
        pluginId === 'reports'
          ? contribution(version)
          : {
              ...contribution(version),
              id: 'plugin:other',
              sourceIdentity: {
                kind: 'local',
                id: 'other',
                source: 'plugins/other',
              },
              provenance: { origin: 'plugin', pluginId: 'other' },
            },
    },
  });
  if (!instance) throw new Error('invalid fixture instance');
  return {
    descriptor: paneDescriptor,
    instance,
    availability: { state: 'available' },
    clientRendererPresence: 'present',
  } as ResolvedWorkspacePaneCatalogEntry;
}

/** The facts the host admits against; each test sets what it needs. */
const facts = vi.hoisted(() => ({
  catalog: {
    projectId: 'project-uuid' as string | undefined,
    projectSlug: 'station' as string | undefined,
    entries: [] as unknown[],
  },
  dock: { projectId: 'project-uuid', projectSlug: 'station' } as {
    projectId: string | null;
    projectSlug: string | null;
  },
  /** The installed version whose renderers the registry admits. */
  registryVersion: '1.0.0' as string | null,
}));

vi.mock('../resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: () => ({
    ...facts.catalog,
    isPending: false,
    isError: false,
    data: {},
  }),
}));

vi.mock('../useDockProject', () => ({
  useDockProject: () => ({ ...facts.dock, pending: false }),
}));

vi.mock('../../contexts/ConfigContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ConfigContext')>()),
  useConfig: () => ({ mcpUiHost: true }),
}));

vi.mock('../../core/PluginRegistry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../core/PluginRegistry')>();
  const Renderer = () => null;
  return {
    ...actual,
    pluginRegistry: {
      getTrustedLayout: (
        _name: string,
        bound: LayoutCatalogContribution | undefined,
      ) =>
        bound !== undefined && bound.version === facts.registryVersion
          ? Renderer
          : null,
      subscribe: () => () => {},
      getLoadStatus: () => ({ state: 'ready' }),
    },
  };
});

const probe = {
  host: undefined as PaneRelatedPanesHost | undefined,
  other: undefined as PaneRelatedPanesHost | undefined,
  model: null as ReturnType<typeof useRegionModel> | null,
  relations: null as PaneRelationsValue | null,
};

function caller(
  occurrenceId: string,
  scope: Record<string, string> = {},
  target: RelatedPaneCaller['target'] = null,
): RelatedPaneCaller {
  const instance = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: LIST.id,
    instanceId: occurrenceId,
    stateKey: occurrenceId,
    boundContext: {
      projectId: PROJECT.projectId,
      ...scope,
      contribution: contribution(),
    },
  }) as WorkspacePaneInstance;
  const made = relatedPaneCaller({
    occurrenceId,
    instance,
    ...PROJECT,
    layoutSlug: 'reports',
    label: 'Reports',
    target,
  });
  if (!made) throw new Error('fixture caller must resolve');
  return made;
}

const callers = {
  first: caller('instance:list'),
  second: caller('instance:list-elsewhere'),
};

function Probe() {
  const host = useRelatedPanesHost(callers.first);
  const other = useRelatedPanesHost(callers.second);
  const model = useRegionModel();
  const relations = usePaneRelations();
  useEffect(() => {
    probe.host = host;
    probe.other = other;
    probe.model = model;
    probe.relations = relations;
  }, [host, other, model, relations]);
  return null;
}

async function mount(initial: Authority = { station: 'station-a' }) {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <AuthorityHarness initial={initial}>
          <RegionModelProvider>
            <PaneRelationsProvider>
              <Probe />
            </PaneRelationsProvider>
          </RegionModelProvider>
        </AuthorityHarness>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(probe.host).toBeDefined());
}

function host(): PaneRelatedPanesHost {
  if (!probe.host) throw new Error('no host');
  return probe.host;
}

async function run<T>(call: () => Promise<T>): Promise<T> {
  let result!: T;
  await act(async () => {
    result = await call();
  });
  return result;
}

// Untrusted on purpose: a frame's request is whatever it sends.
const open = (request: Record<string, unknown>) =>
  run(() =>
    host().open({
      descriptorId: DETAIL.id,
      modeId: 'project',
      key: 'weekly',
      ...request,
    } as RelatedPaneOpenRequest),
  );

function regions() {
  if (!probe.model) throw new Error('probe never rendered');
  return probe.model.regions;
}

function relationOf(id: string) {
  return parsePaneRelations(
    localStorage.getItem(PANE_RELATIONS_STORAGE_KEY),
  ).record.entries.find((entry) => entry.instanceId === id);
}

beforeEach(() => {
  probe.host = undefined;
  probe.other = undefined;
  probe.model = null;
  probe.relations = null;
  facts.catalog = {
    ...PROJECT,
    entries: [entryOf(LIST), entryOf(DETAIL), entryOf(TOOL), entryOf(FOREIGN)],
  };
  facts.dock = { ...PROJECT };
  facts.registryVersion = '1.0.0';
  callers.first = caller('instance:list');
  callers.second = caller('instance:list-elsewhere');
  pluginRelatedPaneBudget.reset();
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  installFakeLocks();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  removeLocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('a plugin opens its own related panes', () => {
  test('a new occurrence is fenced to this Station and records the caller’s scope and generation', async () => {
    callers.first = caller('instance:list', { taskId: 'task-7' });
    await mount();
    const outcome = await open({ title: 'Weekly report' });
    expect(outcome).toMatchObject({ status: 'opened', presentation: 'beside' });
    const handle = (outcome as { handle: string }).handle;
    expect(handle).toMatch(/^plugin-pane:[0-9a-f]{32}$/);
    expect(regions().right.panes).toEqual([handle]);
    expect(readPaneFence(localStorage, handle)).toEqual({
      status: 'fenced',
      stationId: 'station-a',
    });
    expect(readPluginPaneState(localStorage, handle)).toEqual({
      version: 1,
      ...PROJECT,
      pluginId: 'reports',
      generation: callers.first.generation,
      descriptorId: DETAIL.id,
      modeId: 'project',
      key: 'weekly',
      title: 'Weekly report',
      scope: { taskId: 'task-7' },
    });
    expect(relationOf(handle)).toMatchObject({
      stationId: 'station-a',
      generation: callers.first.generation,
      opener: {
        occurrenceId: 'instance:list',
        label: 'Reports',
        source: {
          kind: 'plugin-occurrence',
          projectSlug: 'station',
          layoutSlug: 'reports',
        },
      },
      target: {
        kind: 'plugin',
        pluginId: 'reports',
        descriptorId: DETAIL.id,
        modeId: 'project',
        key: 'weekly',
      },
      kept: false,
    });
    expect(await run(() => host().target())).toBeNull();
  });

  test('the same target focuses, another key replaces the one preview, and a kept pane stays', async () => {
    await mount();
    const first = (await open({ key: 'a' })) as { handle: string };
    expect(await open({ key: 'a' })).toEqual({
      status: 'focused',
      handle: first.handle,
      presentation: 'beside',
    });
    const second = (await open({ key: 'b' })) as {
      status: string;
      handle: string;
    };
    expect(second.status).toBe('replaced');
    expect(regions().right.panes).toEqual([second.handle]);
    // The replaced occurrence is gone with its state and fence.
    expect(readPluginPaneState(localStorage, first.handle)).toBeNull();
    expect(readPaneFence(localStorage, first.handle).status).toBe('none');
    await run(async () => {
      await probe.relations?.keep(second.handle);
    });
    const third = (await open({ key: 'c' })) as {
      status: string;
      handle: string;
    };
    expect(third.status).toBe('opened');
    expect(regions().right.panes).toEqual([second.handle, third.handle]);
  });

  test('a tool opens with the Tools', async () => {
    await mount();
    const outcome = (await open({ descriptorId: TOOL.id })) as {
      status: string;
      handle: string;
      presentation: string;
    };
    expect(outcome).toMatchObject({ status: 'opened', presentation: 'tool' });
    expect(regions().bottom.panes).toContain(outcome.handle);
    expect(regions().right.panes).not.toContain(outcome.handle);
  });

  test.each([
    ['past a bound', { key: 'k'.repeat(257) }, 'invalid-request'],
    ['with a control character', { key: 'a\u0007b' }, 'invalid-request'],
    [
      'naming a field the contract does not define',
      { path: '/etc/passwd' },
      'invalid-request',
    ],
    [
      'for another plugin’s descriptor',
      { descriptorId: FOREIGN.id },
      'unknown-descriptor',
    ],
    [
      'for a built-in pane',
      { descriptorId: 'pane:builtin:workspace-preview:file-preview' },
      'unknown-descriptor',
    ],
    ['for an undeclared mode', { modeId: 'run' }, 'mode-unsatisfiable'],
    [
      'for a mode the caller’s own scope cannot satisfy',
      { modeId: 'task' },
      'mode-unsatisfiable',
    ],
  ])(
    'a request %s is refused and writes nothing',
    async (_name, request, reason) => {
      await mount();
      const before = await settledStorageSnapshot();
      const arrangement = structuredClone(regions());
      expect(await open(request)).toEqual({ status: 'unavailable', reason });
      expect(await settledStorageSnapshot()).toEqual(before);
      expect(regions()).toEqual(arrangement);
    },
  );

  test.each([
    [
      'another Project on screen',
      () => {
        facts.dock = { projectId: 'other-uuid', projectSlug: 'other' };
      },
      { station: 'station-a' } as Authority,
      'context-mismatch',
    ],
    [
      'the plugin updated since the caller was mounted',
      () => {
        facts.catalog = {
          ...PROJECT,
          entries: [entryOf(LIST, '1.1.0'), entryOf(DETAIL, '1.1.0')],
        };
        facts.registryVersion = '1.1.0';
      },
      { station: 'station-a' } as Authority,
      'not-authorized',
    ],
    [
      'an unverified Station',
      () => {},
      'unverified' as Authority,
      'station-unverified',
    ],
  ])(
    'with %s, an open is refused before anything is written',
    async (_name, arrange, authority, reason) => {
      arrange();
      await mount(authority);
      const before = await settledStorageSnapshot();
      expect(await open({})).toEqual({ status: 'unavailable', reason });
      expect(await settledStorageSnapshot()).toEqual(before);
      expect(regions().right.panes).toEqual([]);
    },
  );

  test('a renderer the registry no longer admits is not opened', async () => {
    await mount();
    const before = await settledStorageSnapshot();
    facts.registryVersion = null;
    expect(await open({})).toEqual({
      status: 'unavailable',
      reason: 'not-authorized',
    });
    expect(await settledStorageSnapshot()).toEqual(before);
  });

  test('requests spend one shared budget', async () => {
    await mount();
    const outcomes = [];
    for (let attempt = 0; attempt < 5; attempt += 1)
      outcomes.push(await open({ key: 'same' }));
    expect(outcomes.slice(0, 4).map((outcome) => outcome.status)).toEqual([
      'opened',
      'focused',
      'focused',
      'focused',
    ]);
    expect(outcomes[4]).toEqual({
      status: 'unavailable',
      reason: 'rate-limited',
    });
  });
});

describe('a handle reveals and closes only what its caller opened', () => {
  test('reveal focuses it; another occurrence of the same plugin cannot use it', async () => {
    await mount();
    const { handle } = (await open({})) as { handle: string };
    act(() => probe.model?.placeSurface('activity', 'right'));
    expect(regions().right.occupant).toBe('activity');
    expect(await run(() => host().reveal(handle))).toEqual({
      status: 'focused',
      presentation: 'beside',
    });
    expect(regions().right.occupant).toBe(handle);
    const other = probe.other as PaneRelatedPanesHost;
    expect(await run(() => other.reveal(handle))).toEqual({
      status: 'unavailable',
      reason: 'unknown-handle',
    });
    expect(await run(() => other.close(handle))).toEqual({
      status: 'unavailable',
      reason: 'unknown-handle',
    });
    expect(await run(() => host().close('file-preview:0'))).toEqual({
      status: 'unavailable',
      reason: 'unknown-handle',
    });
    expect(regions().right.panes).toContain(handle);
  });

  test('close asks the pane’s own guard: Cancel keeps everything, Discard removes it with its state, fence and relation', async () => {
    await mount();
    const { handle } = (await open({})) as { handle: string };
    let answer: 'cancel' | 'continue' = 'cancel';
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('dirty related pane'),
      (continueNavigation, cancel) =>
        answer === 'cancel' ? cancel?.() : continueNavigation(),
      handle,
    );
    try {
      expect(await run(() => host().close(handle))).toEqual({
        status: 'unavailable',
        reason: 'guard-cancelled',
      });
      expect(regions().right.panes).toEqual([handle]);
      expect(readPluginPaneState(localStorage, handle)).not.toBeNull();
      answer = 'continue';
      expect(await run(() => host().close(handle))).toEqual({
        status: 'closed',
      });
    } finally {
      unregister();
    }
    expect(regions().right.panes).toEqual([]);
    expect(readPluginPaneState(localStorage, handle)).toBeNull();
    expect(readPaneFence(localStorage, handle).status).toBe('none');
    await waitFor(() => expect(relationOf(handle)).toBeUndefined());
  });

  test('a related occurrence reads the target it was opened for', async () => {
    callers.first = caller(
      'instance:detail',
      {},
      {
        descriptorId: DETAIL.id,
        modeId: 'project',
        key: 'weekly',
      },
    );
    await mount();
    expect(await run(() => host().target())).toEqual({
      descriptorId: DETAIL.id,
      modeId: 'project',
      key: 'weekly',
    });
  });
});
