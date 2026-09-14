/** @vitest-environment jsdom */

/**
 * #2047 D4: the region's "+" catalog. The resolved catalog is stubbed at
 * its hook (the server query and the platform facts are not under test)
 * and the region model at its context; what is proved is what the dock
 * LISTS, what it says of a pane it cannot supply, and that Open goes
 * through the model's placement — never a host's open action.
 */

import {
  createWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  createWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  createWorkspacePlanPaneInstance,
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import {
  parseWorkspacePaneDescriptor,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from '@kontourai/station-contracts/workspace-pane';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { OpenInRegionOutcome } from '../../contexts/RegionModelContext';
import type { RegionId } from '../../regions/region-model';
import type { ResolvedWorkspacePaneCatalogEntry } from '../resolvedWorkspacePaneCatalog';

const harness = vi.hoisted(() => ({
  entries: [] as unknown[],
  refetch: vi.fn(),
  openSurfaceInRegion: vi.fn(),
  panes: [] as string[],
}));

vi.mock('../resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: () => ({
    entries: harness.entries,
    isLoading: false,
    isError: false,
    refetch: harness.refetch,
  }),
}));
vi.mock('../../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../contexts/RegionModelContext')>();
  const { REGION_SURFACE_REGISTRY } = await import(
    '../../regions/region-model'
  );
  const model = {
    get regions() {
      return {
        main: { visible: true, size: 0, panes: ['home'], occupant: 'home' },
        left: { visible: false, size: 400, panes: [], occupant: null },
        right: {
          visible: true,
          size: 400,
          panes: harness.panes,
          occupant: harness.panes[0] ?? null,
        },
        bottom: { visible: true, size: 320, panes: ['chat'], occupant: 'chat' },
      };
    },
    surfaces: REGION_SURFACE_REGISTRY,
    openSurfaceInRegion: harness.openSurfaceInRegion,
  };
  return {
    ...actual,
    useRegionModel: () => model,
    useRegionModelOptional: () => model,
  };
});

import { dockCatalogEntries, RegionPaneCatalog } from '../RegionPaneCatalog';

const AVAILABLE = {
  state: 'available',
  reason: { code: 'ready', source: 'resolver' },
} as const;

/** A dock-capable pane that needs a Task: `docked`, and `task: true`. */
const TASK_NOTES_DESCRIPTOR = parseWorkspacePaneDescriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: 'pane:builtin:task-notes',
  name: 'Task notes',
  description: 'Notes bound to one Task.',
  rendererId: 'renderer:builtin:builtin-component:task-notes',
  renderer: { kind: 'builtin-component', name: 'task-notes' },
  placement: { supportedRegions: ['secondary', 'docked'] },
  modes: [{ id: 'default', contextRequirement: { project: true, task: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});
if (!TASK_NOTES_DESCRIPTOR) throw new Error('fixture must parse');

const terminal = createWorkspaceCodingTerminalPaneInstance('alpha-id');
const plan = createWorkspacePlanPaneInstance('alpha-id');
// The shape the SERVER issues for Chat in a project's catalog: its
// declaration's `createInstance(projectId)` is `createWorkspaceChatPaneInstance`
// with the project's id, so the occurrence is project-bound (the projectless
// one is the shell's own, not the catalog's). Both fold to `chat`.
const chat = createWorkspaceChatPaneInstance('alpha-id');
if (!terminal || !plan || !chat) throw new Error('fixtures must parse');

const ENTRIES: ResolvedWorkspacePaneCatalogEntry[] = [
  {
    descriptor: WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
    instance: terminal,
    availability: AVAILABLE,
    clientRendererPresence: 'present',
  },
  {
    descriptor: WORKSPACE_CHAT_PANE_DESCRIPTOR,
    instance: chat,
    availability: AVAILABLE,
    clientRendererPresence: 'present',
  },
  {
    descriptor: TASK_NOTES_DESCRIPTOR,
    availability: AVAILABLE,
    clientRendererPresence: 'present',
  },
  {
    // Project-only, no `docked`: not a dock pane, so not listed.
    descriptor: WORKSPACE_PLAN_PANE_DESCRIPTOR,
    instance: plan,
    availability: AVAILABLE,
    clientRendererPresence: 'present',
  },
];

beforeEach(() => {
  harness.entries = ENTRIES;
  harness.panes = ['chat'];
  harness.refetch.mockReset();
  harness.openSurfaceInRegion.mockReset();
  harness.openSurfaceInRegion.mockImplementation(
    (surfaceId: string, options?: { region?: RegionId }) =>
      ({
        ok: true,
        region: options?.region ?? 'right',
        surfaceId,
        existing: false,
      }) satisfies OpenInRegionOutcome,
  );
});

afterEach(() => vi.restoreAllMocks());

function renderCatalog(onClose = vi.fn()) {
  render(
    <RegionPaneCatalog
      regionId="right"
      projectSlug="alpha"
      onClose={onClose}
    />,
  );
  return {
    onClose,
    dialog: screen.getByRole('dialog', { name: 'Add pane to Right' }),
  };
}

/**
 * Replacing the `docked` filter with `supportedRegions.includes('primary')`
 * lists Plan and fails the exact-list assertion; dropping the
 * `dockCanSupply` re-resolution leaves Task notes "Available" and fails the
 * reason assertion.
 */
test('lists the panes declaring docked, with a task-bound one disabled and the reason why', () => {
  const listed = dockCatalogEntries(ENTRIES);
  expect(listed.map((entry) => entry.descriptor.name)).toEqual([
    'Terminal',
    'Chat',
    'Task notes',
  ]);
  expect(listed[2]?.availability).toEqual({
    state: 'not-configured',
    reason: { code: 'missing-task', source: 'context' },
    action: { type: 'setup', code: 'select-task' },
  });
  // A reason the server already gave precedes the dock's (resolver order:
  // rollout before context).
  const comingSoon = dockCatalogEntries([
    {
      ...ENTRIES[2]!,
      availability: {
        state: 'coming-soon',
        reason: { code: 'coming-soon', source: 'product-rollout' },
        action: { type: 'learn-more', code: 'view-rollout' },
      },
    },
  ]);
  expect(comingSoon[0]?.availability.state).toBe('coming-soon');

  const { dialog } = renderCatalog();
  const list = within(dialog).getByRole('list', { name: 'Workspace panes' });
  expect(
    within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent?.includes('Plan')),
  ).not.toContain(true);
  expect(
    within(list).getByRole('button', { name: 'Open Terminal' }),
  ).toBeTruthy();
  // Task notes: no Open, a state toggle that explains, and no executable
  // "Select Task" — the dock has no task to select.
  expect(
    within(list).queryByRole('button', { name: 'Open Task notes' }),
  ).toBeNull();
  fireEvent.click(
    within(list).getByRole('button', { name: 'Task notes Setup needed' }),
  );
  expect(
    within(list).getByText('Choose a Task before opening this pane.'),
  ).toBeTruthy();
  expect(
    within(list).getByText('Select Task is not available from this screen.'),
  ).toBeTruthy();
  expect(
    within(list).queryByRole('button', { name: 'Select Task' }),
  ).toBeNull();
});

/**
 * Reverting Open to a host open action (`openAction.open`) fails the first
 * assertion: nothing reaches the model's `openSurfaceInRegion`.
 */
test('Open places the surface through the model in this region and closes; a refusal stays open with its sentence', () => {
  const { dialog, onClose } = renderCatalog();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Open Terminal' }),
  );
  expect(harness.openSurfaceInRegion).toHaveBeenCalledWith('coding:terminal', {
    region: 'right',
  });
  expect(onClose).toHaveBeenCalledTimes(1);

  harness.openSurfaceInRegion.mockImplementation(() => ({
    ok: false,
    reason: 'region-unavailable',
  }));
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Open Terminal' }),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
  const callout = within(dialog).getByRole('alert', {
    name: 'Workspace pane could not open',
  });
  expect(callout.textContent).toContain(
    'That region is not available on this device.',
  );
});

test('a pane the region already holds reads as open in this workspace, with no Open', () => {
  harness.panes = ['chat', 'coding:terminal'];
  const { dialog } = renderCatalog();
  expect(
    within(dialog).queryByRole('button', { name: 'Open Terminal' }),
  ).toBeNull();
  expect(
    within(dialog).getByRole('button', {
      name: 'Terminal Open in this workspace',
    }),
  ).toBeTruthy();
  expect(
    within(dialog).getByRole('button', {
      name: 'Chat Open in this workspace',
    }),
  ).toBeTruthy();
});

test('a retry action refetches the catalog; other actions are explained, not executed', () => {
  harness.entries = [
    {
      ...ENTRIES[0]!,
      availability: {
        state: 'temporarily-unavailable',
        reason: { code: 'health-unavailable', source: 'health' },
        action: { type: 'retry', code: 'retry-availability-check' },
      },
    },
  ];
  const { dialog } = renderCatalog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check again' }));
  expect(harness.refetch).toHaveBeenCalledTimes(1);
  expect(
    within(dialog).getByText('Checking the current pane availability.'),
  ).toBeTruthy();
});
