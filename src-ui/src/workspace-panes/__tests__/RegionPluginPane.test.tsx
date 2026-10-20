/** @vitest-environment jsdom */

/**
 * A related plugin occurrence in a region (`RegionPluginPane`): its Station
 * fence gates it before anything reads its record or its Project's catalog,
 * and on its Station it renders only while the plugin is still the installed
 * generation it was opened under. The catalog, the plugin registry's
 * admission, the layout renderer and the SDK boundary are stubbed; the fence,
 * the relations owner and the Station come from the real providers.
 */

import type { LayoutCatalogContribution } from '@kontourai/station-contracts/layout';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type Authority,
  AuthorityHarness,
  installFakeLocks,
  removeLocks,
} from '../../contexts/__tests__/paneRelationsHarness';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { PaneRelationsProvider } from '../../contexts/PaneRelationsContext';
import { RegionModelProvider } from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { writePaneFence } from '../../regions/pane-fence';
import {
  createPluginPaneStatePreparation,
  pluginPaneInstance,
} from '../pluginPaneOccurrence';
import { RegionPluginPane } from '../RegionPluginPane';
import type { RelatedPaneCaller } from '../relatedPanesHost';

const ID = `plugin-pane:${'b'.repeat(32)}`;
const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };

const GENERATION =
  'plugin:reports@1.0.0:local:reports:plugins/reports#incarnation-1:r0';

const DETAIL = parseWorkspacePaneDescriptor({
  version: '1.0',
  id: 'pane:plugin%3Areports:detail',
  name: 'Report detail',
  rendererId: 'renderer:plugin%3Areports:plugin-component:detail',
  renderer: { kind: 'plugin-component', name: 'detail' },
  placement: { supportedRegions: ['primary'], preferredRegion: 'primary' },
  modes: [{ id: 'project', contextRequirement: { project: true } }],
  provenance: { origin: 'plugin', pluginId: 'reports' },
  lifecycle: { stage: 'stable' },
});

const seen = vi.hoisted(() => ({
  catalogReads: [] as string[],
  version: '1.0.0',
  lifecycle: 'incarnation-1:r0',
  registryAdmits: true,
  related: undefined as unknown,
}));

vi.mock('../resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: (projectSlug: string) => {
    seen.catalogReads.push(projectSlug);
    const instance = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:plugin%3Areports:detail',
      instanceId: 'instance:plugin:project-uuid:detail',
      stateKey: 'state:plugin:project-uuid:detail',
      boundContext: {
        projectId: 'project-uuid',
        contribution: {
          id: 'plugin:reports',
          version: seen.version,
          lifecycleGeneration: seen.lifecycle,
          sourceIdentity: {
            kind: 'local',
            id: 'reports',
            source: 'plugins/reports',
          },
          provenance: { origin: 'plugin', pluginId: 'reports' },
        },
      },
    });
    return {
      projectId: 'project-uuid',
      projectSlug: 'station',
      entries: [
        {
          descriptor: DETAIL,
          instance,
          availability: { state: 'available' },
          clientRendererPresence: 'present',
        },
      ],
      isPending: false,
      isError: false,
      data: {},
    };
  },
}));

vi.mock('../useDockProject', () => ({
  useDockProject: () => ({
    projectId: 'project-uuid',
    projectSlug: 'station',
    pending: false,
  }),
}));

vi.mock('../../contexts/ConfigContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ConfigContext')>()),
  useConfig: () => ({ mcpUiHost: true }),
}));

vi.mock('../../core/PluginRegistry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../core/PluginRegistry')>();
  const Report = () => <p>Report renderer</p>;
  return {
    ...actual,
    pluginRegistry: {
      getTrustedLayout: (_name: string, bound?: LayoutCatalogContribution) =>
        seen.registryAdmits && bound?.version === seen.version ? Report : null,
      subscribe: () => () => {},
      getLoadStatus: () => ({ state: 'ready' }),
    },
  };
});

vi.mock('../../layouts', () => ({
  LayoutRenderer: ({
    trustedPluginLayout: Renderer,
  }: {
    trustedPluginLayout: ComponentType;
  }) => <Renderer />,
}));

vi.mock('../PluginWorkspacePaneSDKBoundary', () => ({
  PluginWorkspacePaneSDKBoundary: ({
    related,
    children,
  }: {
    related?: RelatedPaneCaller | null;
    children: ReactNode;
  }) => {
    seen.related = related;
    return <>{children}</>;
  },
}));

function store(state = {}) {
  expect(
    createPluginPaneStatePreparation(localStorage, ID, {
      version: 1,
      ...PROJECT,
      pluginId: 'reports',
      generation: GENERATION,
      descriptorId: 'pane:plugin%3Areports:detail',
      modeId: 'project',
      key: 'weekly',
      title: 'Weekly report',
      ...state,
    }).prepare(),
  ).toBe(true);
}

function mount(authority: Authority) {
  const instance = pluginPaneInstance(ID, {
    version: 1,
    ...PROJECT,
    pluginId: 'reports',
    generation: GENERATION,
    descriptorId: 'pane:plugin%3Areports:detail',
    modeId: 'project',
    key: 'weekly',
  }) as WorkspacePaneInstance;
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <AuthorityHarness initial={authority}>
          <RegionModelProvider>
            <PaneRelationsProvider>
              <RegionPluginPane instance={instance} />
            </PaneRelationsProvider>
          </RegionModelProvider>
        </AuthorityHarness>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
}

beforeEach(() => {
  seen.catalogReads = [];
  seen.version = '1.0.0';
  seen.lifecycle = 'incarnation-1:r0';
  seen.registryAdmits = true;
  seen.related = undefined;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  installFakeLocks();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  removeLocks();
  vi.unstubAllGlobals();
});

describe('a related plugin occurrence in a region', () => {
  test.each([
    [
      'while the Station is unknown',
      'unverified' as Authority,
      'Checking which Station this is',
    ],
    [
      'on another Station',
      { station: 'station-b' } as Authority,
      'Opened on another Station',
    ],
  ])('reads nothing %s', async (_name, authority, placeholder) => {
    store();
    writePaneFence(localStorage, ID, 'station-a');
    mount(authority);
    expect(await screen.findByText(placeholder)).toBeTruthy();
    expect(seen.catalogReads).toEqual([]);
    expect(screen.queryByText('Report renderer')).toBeNull();
  });

  test('on its own Station it renders under the catalog’s authority, as a caller bound to its own target', async () => {
    store({ scope: { taskId: 'task-7' } });
    writePaneFence(localStorage, ID, 'station-a');
    mount({ station: 'station-a' });
    expect(await screen.findByText('Report renderer')).toBeTruthy();
    expect(seen.catalogReads).toContain('station');
    expect(seen.related).toMatchObject({
      occurrenceId: ID,
      pluginId: 'reports',
      generation: GENERATION,
      ...PROJECT,
      layoutSlug: null,
      scope: { taskId: 'task-7' },
      label: 'Weekly report',
      target: {
        descriptorId: 'pane:plugin%3Areports:detail',
        modeId: 'project',
        key: 'weekly',
      },
    });
  });

  test.each([
    [
      'updated since it was opened',
      () => {
        seen.version = '1.1.0';
      },
    ],
    [
      'no longer admitted by the registry',
      () => {
        seen.registryAdmits = false;
      },
    ],
    [
      'disabled and enabled again',
      () => {
        seen.lifecycle = 'incarnation-1:r2';
      },
    ],
    [
      'reinstalled at the same version',
      () => {
        seen.lifecycle = 'incarnation-2:r0';
      },
    ],
  ])(
    'a plugin %s renders unavailable and runs no plugin code',
    async (_name, arrange) => {
      arrange();
      store();
      writePaneFence(localStorage, ID, 'station-a');
      mount({ station: 'station-a' });
      expect(
        await screen.findByText('This plugin pane is unavailable'),
      ).toBeTruthy();
      expect(screen.queryByText('Report renderer')).toBeNull();
      expect(seen.related).toBeUndefined();
    },
  );

  test('an occurrence whose record is gone says so', async () => {
    writePaneFence(localStorage, ID, 'station-a');
    mount({ station: 'station-a' });
    await waitFor(() =>
      expect(screen.getByText('This pane is no longer available')).toBeTruthy(),
    );
    expect(seen.catalogReads).toEqual([]);
  });
});
