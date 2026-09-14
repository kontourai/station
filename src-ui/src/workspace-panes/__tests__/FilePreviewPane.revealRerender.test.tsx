/** @vitest-environment jsdom */

/**
 * #2085: revealing a file preview that is ALREADY the selected tab of an
 * already-visible region must show the line range the second click asked for,
 * not the one the first click left behind.
 *
 * WHY A SEPARATE SUITE, AND WHAT IT COMPOSES. The storage-side half is already
 * pinned in `RegionModelContext-open-pane.test.tsx`: the opener writes the new
 * range onto the held record and rolls it back when the model refuses. Every
 * one of those assertions reads STORAGE, so all of them passed while the
 * screen still showed the old range — the missing half was a re-render, and
 * only a mounted pane can fail that way. So this suite drives the real opener
 * through the real `RegionModelProvider`, mints the occurrence the way the
 * region host mints it (`regionSurfacePane(...).instance(...)`), and renders
 * the REAL registry component for it.
 *
 * WHAT IS STUBBED AND WHY. `FilePreviewPane` itself is replaced by a stub that
 * prints the range it was handed. Its rendering of a range — the highlighted
 * rows, the requested-range status, the scroll — is `FilePreviewPane.test.tsx`'s
 * subject and is not re-proved here. What this suite is about is one seam: the
 * registry pane reading its stored state through a subscription rather than at
 * render time, so that a write reaches a pane nothing else is re-rendering.
 * The stub is what makes the pane's own render count observable.
 *
 * THE PRECONDITION IS ASSERTED, NOT ASSUMED. The bug needs the reveal to
 * produce an arrangement identical to the one already on screen — that is what
 * makes `regionStatesEqual` hold and both of the model's setters bail. The
 * test asserts `model.regions` keeps its identity across the second open, so a
 * future change that makes the reveal mutate the arrangement (and would
 * therefore re-render the pane for an unrelated reason) cannot quietly turn
 * this into a test of nothing.
 */

import type { WorkspaceFilePreviewPaneState } from '@kontourai/station-contracts/workspace-file-preview';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** Every render of the pane stub, in order, as the range it was given. */
  renders: [] as string[],
}));

vi.mock('../useWorkspacePaneBoundIdentity', () => ({
  useWorkspacePaneBoundIdentity: () => ({
    state: 'resolved',
    project: { id: 'project-uuid', slug: 'station', name: 'Station' },
    layout: undefined,
  }),
}));
vi.mock('../FilePreviewPane', () => ({
  FilePreviewPane: ({
    state,
  }: {
    state: WorkspaceFilePreviewPaneState;
    stateKey: string;
    projectSlug: string;
  }) => {
    const range = state.lineRange
      ? `${state.lineRange.start}-${state.lineRange.end}`
      : 'none';
    mocks.renders.push(range);
    return <output data-testid="preview-range">{range}</output>;
  },
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useFlowDefinitionsQuery: () => ({ data: undefined }),
  useProjectLayoutQuery: () => ({ data: undefined }),
}));
vi.mock('../../hooks/useDerivedSessions', () => ({
  useDerivedSessions: () => [],
}));
vi.mock('../WorkspacePaneHostOpenContext', () => ({
  useWorkspacePaneHostOpenAction: () => null,
}));

import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { useOpenPaneInRegion } from '../../contexts/useOpenInRegion';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { regionSurfacePane } from '../../regions/region-surface-panes';
import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';
import { FILE_PREVIEW_PANE_DESCRIPTOR } from '../filePreviewPaneInstance';

const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };
const PATH = 'src/app.ts';

let model: ReturnType<typeof useRegionModel> | null = null;
let panes: ReturnType<typeof useOpenPaneInRegion> | null = null;

/** The caller a chat link is: not the pane, not the region host. */
function Opener() {
  const value = useRegionModel();
  const openers = useOpenPaneInRegion();
  useEffect(() => {
    model = value;
    panes = openers;
  }, [value, openers]);
  return null;
}

function current() {
  if (!model || !panes) throw new Error('the opener never rendered');
  return { model, panes };
}

/**
 * The occurrence the region host would mint for a placed surface id, through
 * the same fold the host uses — not a hand-built instance, which would let the
 * test pass while the host's own derivation was broken.
 */
function hostOccurrence(surfaceId: string) {
  const pane = regionSurfacePane(surfaceId);
  if (!pane) throw new Error(`no region pane for ${surfaceId}`);
  const instance = pane.instance(PROJECT);
  if (!instance) throw new Error(`no occurrence for ${surfaceId}`);
  return instance;
}

beforeEach(() => {
  model = null;
  panes = null;
  mocks.renders.length = 0;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

test('a second link to the same file re-renders the held pane with the new range', async () => {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Opener />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(panes).not.toBeNull());

  // First click: `src/app.ts#L5` opens as a tab in a dock region, which leaves
  // it SELECTED there and the region VISIBLE — the state the second click
  // arrives into.
  act(() => {
    current().panes.openFilePreview(
      { ...PROJECT, path: PATH, lineRange: { start: 5, end: 5 } },
      { region: 'right' },
    );
  });
  const [held] = current().model.regions.right.panes as [string];
  expect(held).toMatch(/^file-preview:[0-9a-f]{32}$/);

  // The pane mounts, the way the region host mounts it.
  const Pane = getBuiltinWorkspacePaneRenderer(
    FILE_PREVIEW_PANE_DESCRIPTOR,
    hostOccurrence(held),
  );
  if (!Pane) throw new Error('the registry has no File Preview renderer');
  const view = render(
    <Pane
      descriptor={FILE_PREVIEW_PANE_DESCRIPTOR}
      instance={hostOccurrence(held)}
    />,
  );
  // `findBy`, not `getBy`: the registry holds the pane behind `lazy`, so the
  // first paint is the Suspense skeleton.
  expect((await view.findByTestId('preview-range')).textContent).toBe('5-5');
  const rendersBefore = mocks.renders.length;
  expect(rendersBefore).toBeGreaterThan(0);
  const arrangementBefore = current().model.regions;

  // Second click: `src/app.ts#L400-L412`. Nothing re-renders this pane except
  // the write itself — the pane is not a child of the provider here, and the
  // assertion below proves the arrangement did not change either.
  act(() => {
    current().panes.openFilePreview({
      ...PROJECT,
      path: PATH,
      lineRange: { start: 400, end: 412 },
    });
  });

  // The precondition the defect needs: an identical arrangement, so the region
  // setter and the last-shown setter both bail.
  expect(current().model.regions).toBe(arrangementBefore);
  // ...and the pane shows the range that was asked for anyway.
  expect(view.getByTestId('preview-range').textContent).toBe('400-412');
  expect(mocks.renders.slice(rendersBefore)).toContain('400-412');
});

test('a write that changes nothing the pane reads does not re-render it', async () => {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Opener />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(panes).not.toBeNull());

  act(() => {
    current().panes.openFilePreview(
      { ...PROJECT, path: PATH, lineRange: { start: 5, end: 5 } },
      { region: 'right' },
    );
  });
  const [held] = current().model.regions.right.panes as [string];
  const Pane = getBuiltinWorkspacePaneRenderer(
    FILE_PREVIEW_PANE_DESCRIPTOR,
    hostOccurrence(held),
  )!;
  const view = render(
    <Pane
      descriptor={FILE_PREVIEW_PANE_DESCRIPTOR}
      instance={hostOccurrence(held)}
    />,
  );
  // The pane must actually be on screen before "it did not re-render" means
  // anything: a count of zero that stays zero would pass for a pane that never
  // mounted.
  expect((await view.findByTestId('preview-range')).textContent).toBe('5-5');
  const rendersBefore = mocks.renders.length;
  expect(rendersBefore).toBeGreaterThan(0);

  // A SECOND preview, of a different file: its own record is written and its
  // own pane would be notified, but this pane's bytes did not move. The
  // snapshot it reads is identity-stable, so React bails for it — which is
  // what lets one listener set serve every key without every write re-rendering
  // every preview on screen.
  act(() => {
    current().panes.openFilePreview(
      { ...PROJECT, path: 'src/other.ts', lineRange: { start: 1, end: 2 } },
      { region: 'right' },
    );
  });
  expect(mocks.renders.length).toBe(rendersBefore);
});
