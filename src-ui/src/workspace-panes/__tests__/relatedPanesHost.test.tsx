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
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pluginRelatedPaneBudget } from '../../components/plugins/plugin-frame-budget';
import {
  type Authority,
  AuthorityHarness,
  authoritySwitch,
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
import { scopeRelatedPanes } from '../relatedPanesScope';
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
  project = PROJECT,
): ResolvedWorkspacePaneCatalogEntry {
  const pluginId = paneDescriptor.provenance.pluginId as string;
  const instance = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: paneDescriptor.id,
    instanceId: `instance:plugin:${project.projectId}:${paneDescriptor.id}`,
    stateKey: `state:plugin:${project.projectId}:${paneDescriptor.id}`,
    boundContext: {
      projectId: project.projectId,
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
  /** Render again, reading `callers` and `facts` as they are now. */
  rerender: null as (() => void) | null,
  /** Unmount the first caller's occurrence. */
  detachFirst: null as (() => void) | null,
};

function caller(
  occurrenceId: string,
  scope: Record<string, string> = {},
  target: RelatedPaneCaller['target'] = null,
  { project = PROJECT, version = '1.0.0' } = {},
): RelatedPaneCaller {
  const instance = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: LIST.id,
    instanceId: occurrenceId,
    stateKey: occurrenceId,
    boundContext: {
      projectId: project.projectId,
      ...scope,
      contribution: contribution(version),
    },
  }) as WorkspacePaneInstance;
  const made = relatedPaneCaller({
    occurrenceId,
    instance,
    ...project,
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

function FirstCaller() {
  const host = useRelatedPanesHost(callers.first);
  useEffect(() => {
    probe.host = host;
  }, [host]);
  return null;
}

function Probe() {
  const [, setRenders] = useState(0);
  const [firstMounted, setFirstMounted] = useState(true);
  probe.rerender = () => setRenders((count) => count + 1);
  probe.detachFirst = () => setFirstMounted(false);
  const other = useRelatedPanesHost(callers.second);
  const model = useRegionModel();
  const relations = usePaneRelations();
  useEffect(() => {
    probe.other = other;
    probe.model = model;
    probe.relations = relations;
  }, [other, model, relations]);
  return firstMounted ? <FirstCaller /> : null;
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
  probe.rerender = null;
  probe.detachFirst = null;
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
      'the plugin disabled since the caller was mounted',
      () => {
        facts.catalog = { ...PROJECT, entries: [] };
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

  // Admission is asked again inside the lock, after any guard answered: a
  // plugin disabled while the covered pane's guard was up opens nothing.
  test('a plugin disabled while a guard is answering is refused inside the lock', async () => {
    await mount();
    act(() => probe.model?.placeSurface('activity', 'right'));
    const before = await settledStorageSnapshot();
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('covered pane'),
      (continueNavigation) => {
        facts.registryVersion = null;
        continueNavigation();
      },
      'activity',
    );
    try {
      expect(await open({})).toEqual({
        status: 'unavailable',
        reason: 'not-authorized',
      });
    } finally {
      unregister();
    }
    expect(regions().right.panes).toEqual(['activity']);
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

  test('a close that asks nothing spends nothing; one that would ask a guard spends, and asks nothing when refused', async () => {
    await mount();
    const { handle: kept } = (await open({ key: 'kept' })) as {
      handle: string;
    };
    await run(async () => {
      await probe.relations?.keep(kept);
    });
    const { handle: guarded } = (await open({ key: 'guarded' })) as {
      handle: string;
    };
    await run(async () => {
      await probe.relations?.keep(guarded);
    });
    await open({ key: 'third' });
    await open({ key: 'fourth' });
    expect(await open({ key: 'fifth' })).toEqual({
      status: 'unavailable',
      reason: 'rate-limited',
    });
    const asked = vi.fn();
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('dirty related pane'),
      (continueNavigation) => {
        asked();
        continueNavigation();
      },
      guarded,
    );
    try {
      expect(await run(() => host().close(guarded))).toEqual({
        status: 'unavailable',
        reason: 'rate-limited',
      });
      expect(asked).not.toHaveBeenCalled();
      expect(
        Object.values(regions()).flatMap((region) => region.panes),
      ).toContain(guarded);
    } finally {
      unregister();
    }
    expect(await run(() => host().close(kept))).toEqual({ status: 'closed' });
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

const PROJECT_B = { projectId: 'project-b-uuid', projectSlug: 'other' };

/**
 * An unsaved-changes guard for `owner` that answers LATER, as a person
 * reading a prompt does: the test holds the answer and gives it.
 */
function deferredGuard(owner: string) {
  const asked = vi.fn();
  let pending: { proceed: () => void; cancel?: () => void } | null = null;
  const unregister = navigationStore.registerNavigationGuard(
    Symbol(`${owner} draft`),
    (proceed, cancel) => {
      asked();
      pending = { proceed, cancel };
    },
    owner,
  );
  const answer = (choice: 'proceed' | 'cancel') =>
    act(() => {
      const current = pending;
      pending = null;
      if (choice === 'proceed') current?.proceed();
      else current?.cancel?.();
    });
  return { asked, answer, unregister };
}

function pluginPaneKeys() {
  return Object.keys({ ...localStorage })
    .filter((key) => key.includes('plugin-pane:'))
    .sort();
}

async function rerenderWith(change: () => void) {
  const previous = probe.host;
  change();
  act(() => probe.rerender?.());
  await waitFor(() => expect(probe.host).not.toBe(previous));
}

describe('a related target is the exact occurrence, never one bound elsewhere', () => {
  test.each([
    [
      'another Project',
      () => {
        facts.catalog = {
          ...PROJECT_B,
          entries: [
            entryOf(LIST, '1.0.0', PROJECT_B),
            entryOf(DETAIL, '1.0.0', PROJECT_B),
          ],
        };
        facts.dock = { ...PROJECT_B };
        callers.first = caller(
          'instance:list',
          { sessionId: 'session-a', runId: 'run-a' },
          null,
          { project: PROJECT_B },
        );
      },
    ],
    [
      'another Session',
      () => {
        callers.first = caller('instance:list', {
          sessionId: 'session-b',
          runId: 'run-a',
        });
      },
    ],
    [
      'another run',
      () => {
        callers.first = caller('instance:list', {
          sessionId: 'session-a',
          runId: 'run-b',
        });
      },
    ],
    [
      'a later installation of the plugin',
      () => {
        facts.catalog = {
          ...PROJECT,
          entries: [entryOf(LIST, '1.1.0'), entryOf(DETAIL, '1.1.0')],
        };
        facts.registryVersion = '1.1.0';
        callers.first = caller(
          'instance:list',
          { sessionId: 'session-a', runId: 'run-a' },
          null,
          { version: '1.1.0' },
        );
      },
    ],
  ])(
    'a kept report is not focused for a caller bound to %s',
    async (_name, rebind) => {
      callers.first = caller('instance:list', {
        sessionId: 'session-a',
        runId: 'run-a',
      });
      await mount();
      const kept = (await open({})) as { handle: string };
      await run(async () => {
        await probe.relations?.keep(kept.handle);
      });
      const record = readPluginPaneState(localStorage, kept.handle);
      await rerenderWith(rebind);
      const outcome = (await open({})) as { status: string; handle: string };
      expect(outcome.status).toBe('opened');
      expect(outcome.handle).not.toBe(kept.handle);
      expect(readPluginPaneState(localStorage, kept.handle)).toEqual(record);
    },
  );
});

describe('a relation names an occurrence; only its own record says what it is', () => {
  test('a kept occurrence whose stored record is bound elsewhere is not focused for the relation’s target', async () => {
    await mount();
    const kept = (await open({})) as { handle: string };
    await run(async () => {
      await probe.relations?.keep(kept.handle);
    });
    // The occurrence's own record now says another Session; the relation
    // still names this caller's exact target.
    const key = `station:plugin-pane-state:v1:${kept.handle}`;
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    localStorage.setItem(
      key,
      JSON.stringify({ ...stored, scope: { sessionId: 'session-z' } }),
    );
    const outcome = (await open({})) as { status: string; handle: string };
    expect(outcome.status).toBe('opened');
    expect(outcome.handle).not.toBe(kept.handle);
  });
});

describe('a capability acts only for the occurrence and Station it was given to', () => {
  test('one taken on a Station opens nothing once another Station is verified', async () => {
    await mount();
    const stale = host();
    act(() => authoritySwitch.set?.('unverified'));
    act(() => authoritySwitch.set?.({ station: 'station-b' }));
    await waitFor(() => expect(probe.relations?.stationId).toBe('station-b'));
    const before = await settledStorageSnapshot();
    const arrangement = structuredClone(regions());
    expect(
      await run(() =>
        stale.open({ descriptorId: DETAIL.id, modeId: 'project', key: 'w' }),
      ),
    ).toEqual({ status: 'unavailable', reason: 'context-mismatch' });
    expect(await settledStorageSnapshot()).toEqual(before);
    expect(regions()).toEqual(arrangement);
    await waitFor(() => expect(probe.host).not.toBe(stale));
    expect(await open({ key: 'w' })).toMatchObject({ status: 'opened' });
  });

  test('an open whose caller unmounts while a guard is up opens nothing', async () => {
    await mount();
    act(() => probe.model?.placeSurface('activity', 'right'));
    const guard = deferredGuard('activity');
    try {
      const before = await settledStorageSnapshot();
      const arrangement = structuredClone(regions());
      let opening!: Promise<unknown>;
      act(() => {
        opening = host().open({
          descriptorId: DETAIL.id,
          modeId: 'project',
          key: 'weekly',
        });
      });
      await waitFor(() => expect(guard.asked).toHaveBeenCalledTimes(1));
      act(() => probe.detachFirst?.());
      guard.answer('proceed');
      expect(await run(() => opening)).toEqual({
        status: 'unavailable',
        reason: 'context-mismatch',
      });
      expect(await settledStorageSnapshot()).toEqual(before);
      expect(regions()).toEqual(arrangement);
    } finally {
      guard.unregister();
    }
  });

  test.each([
    ['stays current', true],
    ['ends', false],
  ] as const)(
    'a narrowed capability whose scope %s while a guard is up commits only while it is current',
    async (_name, current) => {
      await mount();
      act(() => probe.model?.placeSurface('activity', 'right'));
      const guard = deferredGuard('activity');
      try {
        const before = await settledStorageSnapshot();
        let live = true;
        const narrowed = scopeRelatedPanes(host(), () => live);
        let opening!: Promise<{ status: string }>;
        act(() => {
          opening = narrowed.open({
            descriptorId: DETAIL.id,
            modeId: 'project',
            key: 'weekly',
          }) as Promise<{ status: string }>;
        });
        await waitFor(() => expect(guard.asked).toHaveBeenCalledTimes(1));
        live = current;
        guard.answer('proceed');
        const outcome = await run(() => opening);
        if (current) expect(outcome.status).toBe('opened');
        else {
          expect(outcome).toEqual({
            status: 'unavailable',
            reason: 'context-mismatch',
          });
          expect(await settledStorageSnapshot()).toEqual(before);
        }
      } finally {
        guard.unregister();
      }
    },
  );

  test.each([
    [
      'the Station changes',
      () => authoritySwitch.set?.({ station: 'station-b' }),
    ],
    [
      'the plugin is disabled',
      () => {
        facts.catalog = { ...PROJECT, entries: [] };
        probe.rerender?.();
      },
    ],
    [
      'the plugin is updated',
      () => {
        facts.catalog = {
          ...PROJECT,
          entries: [entryOf(LIST, '1.1.0'), entryOf(DETAIL, '1.1.0')],
        };
        facts.registryVersion = '1.1.0';
        probe.rerender?.();
      },
    ],
    ['its caller unmounts', () => probe.detachFirst?.()],
    [
      'more unsaved work is registered for it',
      () => {
        navigationStore.registerNavigationGuard(
          Symbol('more unsaved work'),
          (proceed) => proceed(),
          closingHandle ?? '',
        );
      },
    ],
  ])(
    'a close whose guard answers after %s removes nothing',
    async (_name, change) => {
      await mount();
      const { handle } = (await open({})) as { handle: string };
      closingHandle = handle;
      const guard = deferredGuard(handle);
      try {
        const before = await settledStorageSnapshot();
        const arrangement = structuredClone(regions());
        const closer = host();
        let closing!: Promise<unknown>;
        act(() => {
          closing = closer.close(handle);
        });
        await waitFor(() => expect(guard.asked).toHaveBeenCalledTimes(1));
        act(() => change());
        guard.answer('proceed');
        expect(await run(() => closing)).toMatchObject({
          status: 'unavailable',
        });
        expect(await settledStorageSnapshot()).toEqual(before);
        expect(regions()).toEqual(arrangement);
      } finally {
        guard.unregister();
        closingHandle = null;
      }
    },
  );
});

let closingHandle: string | null = null;

describe('what a guard was asked about is what the open commits over', () => {
  async function keptReportUnderActivity() {
    await mount();
    const { handle } = (await open({ key: 'weekly' })) as { handle: string };
    await run(async () => {
      await probe.relations?.keep(handle);
    });
    act(() => probe.model?.placeSurface('activity', 'right'));
    expect(regions().right.occupant).toBe('activity');
    return handle;
  }

  const requests: Array<
    [string, (kept: string) => Promise<{ status: string; reason?: string }>]
  > = [
    [
      'a new report',
      () =>
        host().open({
          descriptorId: DETAIL.id,
          modeId: 'project',
          key: 'monthly',
        }) as Promise<{ status: string; reason?: string }>,
    ],
    [
      'the kept report again',
      () =>
        host().open({
          descriptorId: DETAIL.id,
          modeId: 'project',
          key: 'weekly',
        }) as Promise<{ status: string; reason?: string }>,
    ],
    [
      'a reveal of the kept report',
      (kept) =>
        host().reveal(kept) as Promise<{ status: string; reason?: string }>,
    ],
  ];

  test.each(requests)(
    'opening %s over a guard that moves other unsaved work in before it answers opens nothing',
    async (_name, request) => {
      const kept = await keptReportUnderActivity();
      const agentsDirty = vi.fn();
      const unregisterAgents = navigationStore.registerNavigationGuard(
        Symbol('agents draft'),
        (_proceed, cancel) => {
          agentsDirty();
          cancel?.();
        },
        'workspace-agents',
      );
      const unregister = navigationStore.registerNavigationGuard(
        Symbol('activity draft'),
        (proceed) => {
          // Before answering, in the same event and before any render:
          // another pane with unsaved work takes the region's front.
          probe.model?.placeSurface('workspace-agents', 'right');
          proceed();
        },
        'activity',
      );
      try {
        const relations = localStorage.getItem(PANE_RELATIONS_STORAGE_KEY);
        const plugin = pluginPaneKeys();
        expect(await run(() => request(kept))).toMatchObject({
          status: 'unavailable',
        });
        expect(agentsDirty).not.toHaveBeenCalled();
        expect(regions().right.occupant).toBe('workspace-agents');
        expect(localStorage.getItem(PANE_RELATIONS_STORAGE_KEY)).toBe(
          relations,
        );
        expect(pluginPaneKeys()).toEqual(plugin);
      } finally {
        unregister();
        unregisterAgents();
      }
    },
  );

  test.each(requests)(
    'opening %s while more unsaved work is registered for the asked pane opens nothing',
    async (_name, request) => {
      const kept = await keptReportUnderActivity();
      const first = deferredGuard('activity');
      let second: ReturnType<typeof deferredGuard> | null = null;
      try {
        const before = await settledStorageSnapshot();
        const arrangement = structuredClone(regions());
        let pending!: Promise<{ status: string; reason?: string }>;
        act(() => {
          pending = request(kept);
        });
        await waitFor(() => expect(first.asked).toHaveBeenCalledTimes(1));
        second = deferredGuard('activity');
        first.answer('proceed');
        expect(await run(() => pending)).toMatchObject({
          status: 'unavailable',
        });
        expect(second.asked).not.toHaveBeenCalled();
        expect(await settledStorageSnapshot()).toEqual(before);
        expect(regions()).toEqual(arrangement);
      } finally {
        first.unregister();
        second?.unregister();
      }
    },
  );
});
