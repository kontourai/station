/** @vitest-environment jsdom */

import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_REGIONS,
} from '@kontourai/station-contracts/workspace-pane';
import {
  parseWorkspacePaneHostDocument,
  type WorkspacePaneHostDocumentV1,
  workspacePaneHostScopeMatches,
  workspacePaneHostScopeProjectId,
} from '@kontourai/station-contracts/workspace-pane-host';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { WorkspacePaneHost } from '../WorkspacePaneHost';
import type { WorkspacePaneHostLockManager } from '../workspacePaneHostLease';
import { workspacePaneHostScopeKey } from '../workspacePaneHostNavigation';
import { workspacePaneHostStorageKey } from '../workspacePaneHostStorage';

const occupant = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'Occupant',
  instanceId: 'occupant',
  stateKey: 'occupant',
})!;
const other = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'Other',
  instanceId: 'other',
  stateKey: 'other',
})!;

function ambientDocument(): WorkspacePaneHostDocumentV1 {
  return {
    version: '1.1',
    id: 'dock',
    scope: { kind: 'ambient' },
    instances: [occupant],
    activeInstanceId: occupant.instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [occupant.instanceId],
      selectedInstanceId: occupant.instanceId,
    },
  };
}

function projectDocument(): WorkspacePaneHostDocumentV1 {
  return {
    version: '1.1',
    id: 'dock',
    scope: { kind: 'project', projectId: 'project', layoutId: 'layout' },
    instances: [occupant, other],
    activeInstanceId: occupant.instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [occupant.instanceId, other.instanceId],
      selectedInstanceId: occupant.instanceId,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Ambient scope kind
// ---------------------------------------------------------------------------

test('the project and task storage keys are byte-identical to what they were before the ambient kind existed', () => {
  expect(
    workspacePaneHostStorageKey(
      { kind: 'project', projectId: 'project', layoutId: 'layout' },
      'host',
    ),
  ).toBe('station:workspace-pane-host:v2:project:project:layout:host');
  expect(
    workspacePaneHostStorageKey(
      {
        kind: 'task',
        projectId: 'project',
        taskId: 'task',
        layoutId: 'layout',
      },
      'host',
    ),
  ).toBe('station:workspace-pane-host:v2:task:task:project:layout:host');
});

test('the ambient storage key is stable, per device, and names no project or layout', () => {
  const key = workspacePaneHostStorageKey({ kind: 'ambient' }, 'dock');
  expect(key).toBe('station:workspace-pane-host:v2:ambient:dock');
  expect(workspacePaneHostStorageKey({ kind: 'ambient' }, 'dock')).toBe(key);
  expect(key).not.toContain('project');
  expect(key).not.toContain('layout');
});

test('an ambient key is distinct from every project or task key of the same document id', () => {
  const ambient = workspacePaneHostStorageKey({ kind: 'ambient' }, 'dock');
  const project = workspacePaneHostStorageKey(
    { kind: 'project', projectId: 'project', layoutId: 'layout' },
    'dock',
  );
  const task = workspacePaneHostStorageKey(
    { kind: 'task', projectId: 'project', taskId: 'task', layoutId: 'layout' },
    'dock',
  );
  expect(new Set([ambient, project, task]).size).toBe(3);
});

test('the ambient navigation scope key is distinct from the project and task keys', () => {
  const keys = [
    workspacePaneHostScopeKey({ kind: 'ambient' }),
    workspacePaneHostScopeKey({
      kind: 'project',
      projectId: 'project',
      layoutId: 'layout',
    }),
    workspacePaneHostScopeKey({
      kind: 'task',
      projectId: 'project',
      taskId: 'task',
      layoutId: 'layout',
    }),
  ];
  expect(new Set(keys).size).toBe(3);
});

test('an ambient scope names no project, and scope equality is total over all three kinds', () => {
  expect(workspacePaneHostScopeProjectId({ kind: 'ambient' })).toBeUndefined();
  expect(
    workspacePaneHostScopeProjectId({
      kind: 'project',
      projectId: 'project',
      layoutId: 'layout',
    }),
  ).toBe('project');
  expect(
    workspacePaneHostScopeMatches({ kind: 'ambient' }, { kind: 'ambient' }),
  ).toBe(true);
  expect(
    workspacePaneHostScopeMatches(
      { kind: 'ambient' },
      { kind: 'project', projectId: 'project', layoutId: 'layout' },
    ),
  ).toBe(false);
  expect(
    workspacePaneHostScopeMatches(
      { kind: 'project', projectId: 'project', layoutId: 'layout' },
      { kind: 'project', projectId: 'project', layoutId: 'other' },
    ),
  ).toBe(false);
});

test('an ambient document round-trips, and one carrying a project identity is rejected', () => {
  const parsed = parseWorkspacePaneHostDocument(ambientDocument());
  expect(parsed?.scope).toEqual({ kind: 'ambient' });
  expect(
    parseWorkspacePaneHostDocument({
      ...ambientDocument(),
      scope: { kind: 'ambient', projectId: 'project', layoutId: 'layout' },
    }),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// 2. The docked region
// ---------------------------------------------------------------------------

test('docked is part of the one region vocabulary the descriptor parser accepts', () => {
  expect(WORKSPACE_PANE_REGIONS).toContain('docked');
  const descriptor = parseWorkspacePaneDescriptor({
    version: '1.0',
    id: 'pane:test:docked',
    name: 'Docked',
    rendererId: 'renderer:test:docked',
    renderer: { kind: 'builtin-component', name: 'workspace-chat' },
    placement: { supportedRegions: ['docked'], preferredRegion: 'docked' },
    modes: [{ id: 'default' }],
    provenance: { origin: 'builtin' },
    lifecycle: { stage: 'stable' },
  });
  expect(descriptor?.placement.supportedRegions).toEqual(['docked']);
  expect(descriptor?.placement.preferredRegion).toBe('docked');
});

// ---------------------------------------------------------------------------
// 3. Chromeless single-occupant presentation
// ---------------------------------------------------------------------------

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

/** Grants the persistence lock, so `canPersist` is true and the tabbed
 * branch would offer its maximise affordance. Without it both branches
 * report the same single display mode and the comparison proves nothing. */
const grantingLockManager = (): WorkspacePaneHostLockManager => ({
  request: async (_name, _options, callback) => callback({}),
});

function renderChromeless() {
  return render(
    <WorkspacePaneHost
      document={ambientDocument()}
      presentation="chromeless"
      storage={memoryStorage()}
      lockManager={grantingLockManager()}
      renderPane={(instance) => <p>Occupant {instance.instanceId}</p>}
    />,
  );
}

test('the chromeless presentation renders its occupant', () => {
  renderChromeless();
  expect(screen.getByText('Occupant occupant')).toBeTruthy();
});

test('the chromeless presentation renders no persistence status line', () => {
  renderChromeless();
  expect(
    screen.queryByRole('status'),
    'the persistence status line reappeared in the chromeless presentation',
  ).toBeNull();
});

test('the chromeless presentation renders no tab strip', () => {
  renderChromeless();
  expect(
    screen.queryByRole('tablist'),
    'the tab strip reappeared in the chromeless presentation',
  ).toBeNull();
  expect(
    screen.queryByRole('tabpanel'),
    'the occupant was wrapped in a tab panel in the chromeless presentation',
  ).toBeNull();
});

test('the chromeless presentation renders no pane commands', () => {
  renderChromeless();
  expect(
    screen.queryByLabelText('Pane actions for Occupant'),
    'the pane command surface reappeared in the chromeless presentation',
  ).toBeNull();
});

test('the default presentation still renders all three chrome elements', () => {
  render(
    <WorkspacePaneHost
      document={projectDocument()}
      storage={memoryStorage()}
      lockManager={grantingLockManager()}
      renderPane={(instance) => <p>Occupant {instance.instanceId}</p>}
    />,
  );
  expect(screen.getByText('Occupant occupant')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('Workspace');
  expect(screen.getByRole('tablist')).toBeTruthy();
  expect(screen.getByLabelText('Pane actions for Occupant')).toBeTruthy();
});

test('the chromeless presentation tells its pane that inline is the only display mode', async () => {
  const modes: string[][] = [];
  render(
    <WorkspacePaneHost
      document={ambientDocument()}
      presentation="chromeless"
      storage={memoryStorage()}
      lockManager={grantingLockManager()}
      renderPane={(instance, presentation) => {
        modes.push([...presentation.availableDisplayModes]);
        return <p>Occupant {instance.instanceId}</p>;
      }}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(modes.length).toBeGreaterThan(0);
  expect(
    modes.map((entry) => entry.join(',')),
    'a chromeless host offered a display mode it has no affordance for',
  ).toEqual(modes.map(() => 'inline'));
});

test('the chromeless dock slot replaces and persists its one occupant', async () => {
  const storage = memoryStorage();
  const onDockSlotActionChange = vi.fn();
  render(
    <WorkspacePaneHost
      document={ambientDocument()}
      presentation="chromeless"
      storage={storage}
      lockManager={grantingLockManager()}
      onDockSlotActionChange={onDockSlotActionChange}
      renderPane={(instance) => <p>Occupant {instance.instanceId}</p>}
    />,
  );
  await waitFor(() => expect(onDockSlotActionChange).toHaveBeenCalled());
  const replace = onDockSlotActionChange.mock.calls.at(-1)?.[0];
  expect(
    replace,
    'the ambient dock replacement authority was not supplied',
  ).toBeTypeOf('function');
  expect(replace!(other)).toBe(true);
  await waitFor(() => expect(screen.getByText('Occupant other')).toBeTruthy());
  const persisted = storage.getItem(
    'station:workspace-pane-host:v2:ambient:dock',
  );
  expect(
    persisted,
    'the ambient document did not persist the replacement',
  ).toContain('"other"');
  expect(persisted).not.toContain('"occupant"');
});
