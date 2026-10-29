/** @vitest-environment jsdom */

/**
 * The Station fence of a related file preview, at the MOUNTED reader
 * (docs/design/pane-relationships.md: target identity includes the Station).
 *
 * The registry's real File Preview component is rendered for a fenced
 * occurrence while the verified Station moves A → unverified → B → A. What
 * is observed is the reader's first identity read (the bound-identity hook,
 * which issues the Project/layout queries) and the preview body (which
 * fetches the file): while the Station is unknown or another one, neither
 * may run at all — not a request that is later discarded.
 */

import type { WorkspaceFilePreviewPaneState } from '@kontourai/station-contracts/workspace-file-preview';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const reads = vi.hoisted(() => ({ identity: 0, body: 0 }));

vi.mock('../useWorkspacePaneBoundIdentity', () => ({
  useWorkspacePaneBoundIdentity: () => {
    reads.identity += 1;
    return {
      state: 'resolved',
      project: { id: 'project-uuid', slug: 'station', name: 'Station' },
      layout: undefined,
    };
  },
}));
vi.mock('../FilePreviewPane', () => ({
  FilePreviewPane: ({ state }: { state: WorkspaceFilePreviewPaneState }) => {
    reads.body += 1;
    return <output data-testid="preview-body">{state.path}</output>;
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

import {
  AuthorityHarness,
  authoritySwitch,
} from '../../contexts/__tests__/paneRelationsHarness';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { PaneRelationsProvider } from '../../contexts/PaneRelationsContext';
import { writePaneFence } from '../../regions/pane-fence';
import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';
import {
  createFilePreviewPaneInstance,
  FILE_PREVIEW_PANE_DESCRIPTOR,
} from '../filePreviewPaneInstance';
import { writeFilePreviewPaneState } from '../filePreviewPaneStateStorage';

const STATE: WorkspaceFilePreviewPaneState = {
  version: '1.0',
  projectSlug: 'station',
  path: 'src/secret.ts',
  wrap: true,
};

function fencedInstance(fence: 'station-a' | 'none' | 'unreadable') {
  const instance = createFilePreviewPaneInstance(STATE, 'project-uuid');
  if (!instance) throw new Error('fixture instance did not mint');
  const id = String(instance.instanceId);
  writeFilePreviewPaneState(localStorage, id, STATE);
  if (fence === 'station-a') writePaneFence(localStorage, id, 'station-a');
  if (fence === 'unreadable')
    localStorage.setItem(
      `station:pane-fence:v1:${encodeURIComponent(id)}`,
      '{',
    );
  return instance;
}

function renderPreview(
  instance: ReturnType<typeof fencedInstance>,
  initial: Parameters<typeof AuthorityHarness>[0]['initial'],
) {
  const Pane = getBuiltinWorkspacePaneRenderer(
    FILE_PREVIEW_PANE_DESCRIPTOR,
    instance,
  );
  if (!Pane) throw new Error('no File Preview renderer');
  return render(
    <NavigationProvider>
      <AuthorityHarness initial={initial}>
        <PaneRelationsProvider>
          <Pane descriptor={FILE_PREVIEW_PANE_DESCRIPTOR} instance={instance} />
        </PaneRelationsProvider>
      </AuthorityHarness>
    </NavigationProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  reads.identity = 0;
  reads.body = 0;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('A → unverified → B → A: the reader reads only while the verified Station is A', async () => {
  renderPreview(fencedInstance('station-a'), { station: 'station-a' });
  expect(await screen.findByTestId('preview-body')).toBeTruthy();
  expect(reads.identity).toBeGreaterThan(0);

  const identityBefore = reads.identity;
  const bodyBefore = reads.body;
  act(() => authoritySwitch.set?.('unverified'));
  expect(
    await screen.findByText('Checking which Station this is'),
  ).toBeTruthy();
  expect(screen.queryByTestId('preview-body')).toBeNull();

  act(() => authoritySwitch.set?.({ station: 'station-b' }));
  expect(await screen.findByText('Opened on another Station')).toBeTruthy();
  expect(screen.queryByTestId('preview-body')).toBeNull();
  // Neither gated state ran the reader's identity read or its body.
  expect(reads.identity).toBe(identityBefore);
  expect(reads.body).toBe(bodyBefore);

  act(() => authoritySwitch.set?.({ station: 'station-a' }));
  expect(await screen.findByTestId('preview-body')).toBeTruthy();
  expect(reads.identity).toBeGreaterThan(identityBefore);
});

test('mounted while the Station is unknown, a fenced preview reads nothing', async () => {
  renderPreview(fencedInstance('station-a'), 'unavailable');
  expect(
    await screen.findByText('Checking which Station this is'),
  ).toBeTruthy();
  expect(reads).toEqual({ identity: 0, body: 0 });
});

test('a fence this build cannot read stays closed, even on a verified Station', async () => {
  renderPreview(fencedInstance('unreadable'), { station: 'station-a' });
  expect(
    await screen.findByText('This pane cannot be shown here'),
  ).toBeTruthy();
  expect(reads).toEqual({ identity: 0, body: 0 });
});

test('an unfenced (pre-relationship) preview renders as before', async () => {
  renderPreview(fencedInstance('none'), 'unverified');
  await waitFor(() => expect(screen.getByTestId('preview-body')).toBeTruthy());
});
