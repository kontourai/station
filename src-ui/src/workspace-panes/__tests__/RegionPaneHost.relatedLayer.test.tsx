/** @vitest-environment jsdom */

/**
 * Related previews opened over Chat on a phone (the phone layer) through the
 * shipped shells (docs/design/pane-relationships.md): the layer's way back
 * names the conversation, a kept preview stays placed through a replacement,
 * Back and a reopen, and a layer pane holding unsaved work is never taken off
 * screen without its own guard's answer.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RegionShells } from '../../app-shell/RegionShells';
import {
  AuthorityHarness,
  installFakeLocks,
  removeLocks,
  settledStorageSnapshot,
} from '../../contexts/__tests__/paneRelationsHarness';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  type RelatedOpenOutcome,
  useOpenRelatedFilePreview,
} from '../../contexts/openRelatedFilePreview';
import {
  PaneRelationsProvider,
  type PaneRelationsValue,
  usePaneRelations,
} from '../../contexts/PaneRelationsContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { readPaneFence } from '../../regions/pane-fence';
import type { PaneOpener } from '../../regions/pane-relations';
import { readFilePreviewPaneState } from '../filePreviewPaneStateStorage';

vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => null,
  renderAmbientChatPane: () => <p>Chat pane</p>,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: () => ({ project: undefined, isLoading: false }),
}));
vi.mock('../../contexts/ConfigContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ConfigContext')>()),
  useConfig: () => null,
}));

const OPENER: PaneOpener = {
  occurrenceId: 'chat',
  label: 'Security review',
  source: {
    kind: 'conversation',
    conversationId: 'conversation-security',
    threadId: 'thread-security',
    projectSlug: 'station',
  },
};
const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };

let open: ReturnType<typeof useOpenRelatedFilePreview> = null;
let model: ReturnType<typeof useRegionModel> | null = null;
let relations: PaneRelationsValue | null = null;

function Probe() {
  const value = useRegionModel();
  const openPreview = useOpenRelatedFilePreview(OPENER);
  const currentRelations = usePaneRelations();
  useEffect(() => {
    model = value;
    open = openPreview;
    relations = currentRelations;
  }, [value, openPreview, currentRelations]);
  return null;
}

beforeEach(() => {
  open = null;
  model = null;
  relations = null;
  localStorage.clear();
  sessionStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  installFakeLocks();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  removeLocks();
  delete (window as { matchMedia?: unknown }).matchMedia;
  window.history.replaceState({}, '', '/');
});

async function mount() {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <AuthorityHarness initial={{ station: 'station-a' }}>
          <RegionModelProvider>
            <PaneRelationsProvider>
              <Probe />
              <RegionShells />
            </PaneRelationsProvider>
          </RegionModelProvider>
        </AuthorityHarness>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(open).not.toBeNull());
}

async function openFile(path: string): Promise<RelatedOpenOutcome> {
  let outcome!: RelatedOpenOutcome;
  await act(async () => {
    const openPreview = open;
    if (!openPreview) throw new Error('no opener');
    outcome = await openPreview({ ...PROJECT, path });
  });
  return outcome;
}

function layerPane(): string | undefined {
  return model?.phoneLayer?.surfaceId;
}

test('the phone layer’s way back names the conversation a related preview came from', async () => {
  await mount();
  await openFile('a.ts');
  await waitFor(() => expect(model?.phoneLayer).not.toBeNull());
  const back = await screen.findByRole('button', {
    name: 'Back to Security review',
  });
  expect(back.textContent).toContain('Security review');
  act(() => back.click());
  await waitFor(() => expect(model?.phoneLayer).toBeNull());
  expect(model?.regions.bottom.occupant).toBe('chat');
});

test('on a phone, Keep survives replacing the layer’s pane, Back, and an exact reopen', async () => {
  await mount();
  await openFile('a.ts');
  const kept = layerPane() as string;
  expect(kept).toMatch(/^file-preview:/);
  await act(async () => {
    expect((await relations?.keep(kept))?.ok).toBe(true);
  });

  expect(await openFile('b.ts')).toMatchObject({
    ok: true,
    disposition: 'opened',
  });
  const transient = layerPane() as string;
  expect(transient).not.toBe(kept);
  // The kept pane is still placed — an ordinary tab of Chat's region — and
  // its state is untouched.
  expect(model?.regions.bottom.panes).toContain(kept);
  expect(readFilePreviewPaneState(localStorage, kept)?.path).toBe('a.ts');

  act(() =>
    screen.getByRole('button', { name: 'Back to Security review' }).click(),
  );
  await waitFor(() => expect(model?.phoneLayer).toBeNull());
  expect(model?.regions.bottom.occupant).toBe('chat');
  // Back took away the transient tab the layer minted, not the kept one.
  expect(model?.regions.bottom.panes).toContain(kept);
  expect(model?.regions.bottom.panes).not.toContain(transient);

  expect(await openFile('a.ts')).toMatchObject({
    ok: true,
    disposition: 'focused',
    surfaceId: kept,
  });
  await waitFor(() => expect(layerPane()).toBe(kept));
});

test('a layer pane with unsaved work: Cancel changes nothing; continue keeps it placed', async () => {
  await mount();
  await openFile('a.ts');
  const dirty = layerPane() as string;
  let answer: 'cancel' | 'continue' = 'cancel';
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('dirty layer pane'),
    (continueNavigation, cancel) =>
      answer === 'cancel' ? cancel?.() : continueNavigation(),
    dirty,
  );
  try {
    // Beginning the edit kept it.
    await waitFor(() => expect(relations?.relationOf(dirty)?.kept).toBe(true));
    const arrangement = structuredClone(model?.regions);
    const before = await settledStorageSnapshot();
    const focused = document.activeElement;
    expect(await openFile('b.ts')).toEqual({
      ok: false,
      reason: 'guard-cancelled',
    });
    expect(model?.regions).toEqual(arrangement);
    expect(await settledStorageSnapshot()).toEqual(before);
    expect(layerPane()).toBe(dirty);
    expect(document.activeElement).toBe(focused);

    answer = 'continue';
    expect(await openFile('b.ts')).toMatchObject({ ok: true });
    expect(layerPane()).not.toBe(dirty);
    expect(model?.regions.bottom.panes).toContain(dirty);
    expect(readFilePreviewPaneState(localStorage, dirty)?.path).toBe('a.ts');
  } finally {
    unregister();
  }
});

test('on a desktop, closing a related preview’s tab asks its guard, then removes its state, fence and relation', async () => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  await mount();
  act(() => model?.placeSurface('activity', 'right'));
  const opened = await openFile('a.ts');
  expect(opened).toMatchObject({ ok: true, region: 'right' });
  const preview = model?.regions.right.panes.find((id) =>
    id.startsWith('file-preview:'),
  ) as string;
  expect(readPaneFence(localStorage, preview).status).toBe('fenced');
  const close = await screen.findByLabelText(/^Close a\.ts/);

  // With unsaved work, the preview's own guard answers first: Cancel leaves
  // the arrangement, the focus, its state, its fence and its relation.
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('dirty preview'),
    (_continue, cancel) => cancel?.(),
    preview,
  );
  try {
    await waitFor(() =>
      expect(relations?.relationOf(preview)?.kept).toBe(true),
    );
    act(() => close.focus());
    const arrangement = structuredClone(model?.regions);
    const before = await settledStorageSnapshot();
    act(() => close.click());
    expect(model?.regions).toEqual(arrangement);
    expect(await settledStorageSnapshot()).toEqual(before);
    expect(document.activeElement).toBe(close);
    expect(relations?.relationOf(preview)).toBeDefined();
  } finally {
    unregister();
  }

  act(() => close.click());
  await waitFor(() => expect(model?.regions.right.panes).toEqual(['activity']));
  expect(readFilePreviewPaneState(localStorage, preview)).toBe(null);
  expect(readPaneFence(localStorage, preview)).toEqual({ status: 'none' });
  await waitFor(() => expect(relations?.relationOf(preview)).toBeUndefined());
});
