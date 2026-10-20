/** @vitest-environment jsdom */

/**
 * Up from a related pane returns to EXACTLY its opener through the shell's
 * canonical navigation (docs/design/pane-relationships.md), including after
 * the source or the dock's Project changed. Observed as canonical outcomes —
 * the navigation `chat` selection and URL, the routed Project layout, the
 * region model — not as spies on the strip.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const layouts = vi.hoisted(() => ({
  bySlug: {} as Record<string, { slug: string; type: string }[]>,
}));
const PROJECTS = vi.hoisted(() => [
  { id: 'alpha-id', slug: 'alpha', name: 'Alpha' },
  { id: 'beta-id', slug: 'beta', name: 'Beta' },
]);

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useProjectLayoutsQuery: (slug: string) => ({
    data: layouts.bySlug[slug],
  }),
}));
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: PROJECTS,
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: (slug: string) => ({
    project: PROJECTS.find((project) => project.slug === slug),
    isLoading: false,
  }),
}));

import { AuthorityHarness } from '../../contexts/__tests__/paneRelationsHarness';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { PaneRelationsProvider } from '../../contexts/PaneRelationsContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { writePaneFence } from '../../regions/pane-fence';
import {
  PANE_RELATIONS_STORAGE_KEY,
  type PaneOpener,
  type PaneRelation,
  serializePaneRelations,
} from '../../regions/pane-relations';
import { RelatedPaneStrip } from '../RelatedPaneStrip';

const ID = 'file-preview:0123456789abcdef0123456789abcdef';

let model: ReturnType<typeof useRegionModel> | null = null;
function ModelProbe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function seedRelation(opener: PaneOpener, stationId = 'station-a') {
  const relation: PaneRelation = {
    instanceId: ID,
    stateKey: ID,
    stationId,
    generation: 'builtin',
    opener,
    target: {
      kind: 'file',
      projectId: 'alpha-id',
      projectSlug: 'alpha',
      path: 'src/a.ts',
      thread: null,
    },
    kept: true,
    openedAt: 1,
  };
  writePaneFence(localStorage, ID, stationId);
  localStorage.setItem(
    PANE_RELATIONS_STORAGE_KEY,
    serializePaneRelations({ version: 1, entries: [relation] }),
  );
}

function mount() {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <AuthorityHarness initial={{ station: 'station-a' }}>
          <RegionModelProvider>
            <PaneRelationsProvider>
              <ModelProbe />
              <RelatedPaneStrip instanceId={ID} />
            </PaneRelationsProvider>
          </RegionModelProvider>
        </AuthorityHarness>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
}

beforeEach(() => {
  model = null;
  layouts.bySlug = {};
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
  navigationStore.navigate('/', { chat: null, dock: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('Up to a conversation opener', () => {
  test('a conversation-only opener is navigable after the source moved on', async () => {
    seedRelation({
      occurrenceId: 'chat',
      label: 'Release review',
      source: {
        kind: 'conversation',
        conversationId: 'conversation-release',
        threadId: null,
        projectSlug: 'alpha',
      },
    });
    mount();
    // The reader has since moved Chat to another conversation.
    act(() => navigationStore.setActiveChat('conversation-other'));
    act(() =>
      screen.getByRole('button', { name: 'Up to Release review' }).click(),
    );
    await waitFor(() =>
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-release',
      ),
    );
    expect(new URLSearchParams(window.location.search).get('chat')).toBe(
      'conversation-release',
    );
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
  });

  test('a session-only opener asks Chat for that session', async () => {
    seedRelation({
      occurrenceId: 'chat',
      label: 'Imported session',
      source: {
        kind: 'conversation',
        conversationId: null,
        threadId: 'thread-imported',
        projectSlug: null,
      },
    });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() =>
      screen.getByRole('button', { name: 'Up to Imported session' }).click(),
    );
    await waitFor(() =>
      expect(model?.surfaceIntents.chat?.session).toBe('thread-imported'),
    );
  });
});

describe('Up to a Files opener', () => {
  const ALPHA_FILES: PaneOpener = {
    occurrenceId: 'coding:file-browser',
    label: 'Files · Alpha',
    source: { kind: 'files', projectId: 'alpha-id', projectSlug: 'alpha' },
  };

  test('after the dock moved to another Project, Up goes to the captured Project’s Files, not the dock’s', async () => {
    deviceSettingsStore.set('chatDockProjectSlug', 'beta');
    layouts.bySlug.alpha = [
      { slug: 'overview', type: 'tasks' },
      { slug: 'alpha-coding', type: 'coding' },
    ];
    seedRelation(ALPHA_FILES);
    mount();
    act(() =>
      screen.getByRole('button', { name: 'Up to Files · Alpha' }).click(),
    );
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        '/projects/alpha/layouts/alpha-coding',
      ),
    );
    // A canonical navigation, so the dock then follows the reader to Alpha
    // by navigation's own Project-default rule — the same as a click on that
    // layout — rather than the strip rebinding it to fake an exact return.
    expect(navigationStore.getSnapshot().selectedProject).toBe('alpha');
  });

  test('with no Coding layout, Up goes to the captured Project', async () => {
    deviceSettingsStore.set('chatDockProjectSlug', 'beta');
    layouts.bySlug.alpha = [{ slug: 'overview', type: 'tasks' }];
    seedRelation(ALPHA_FILES);
    mount();
    act(() =>
      screen.getByRole('button', { name: 'Up to Files · Alpha' }).click(),
    );
    await waitFor(() =>
      expect(window.location.pathname.startsWith('/projects/alpha')).toBe(true),
    );
  });

  test('while the dock is bound to that Project, Up reveals the dock’s Files pane', async () => {
    deviceSettingsStore.set('chatDockProjectSlug', 'alpha');
    seedRelation(ALPHA_FILES);
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() =>
      screen.getByRole('button', { name: 'Up to Files · Alpha' }).click(),
    );
    await waitFor(() =>
      expect(
        Object.values(model?.regions ?? {}).some((region) =>
          region.panes.includes('coding:file-browser'),
        ),
      ).toBe(true),
    );
  });
});

test('a relation recorded on another Station offers no Up', () => {
  seedRelation(
    {
      occurrenceId: 'chat',
      label: 'Release review',
      source: {
        kind: 'conversation',
        conversationId: 'conversation-release',
        threadId: null,
        projectSlug: 'alpha',
      },
    },
    'station-b',
  );
  mount();
  expect(screen.queryByRole('button', { name: /^Up to/ })).toBeNull();
});
