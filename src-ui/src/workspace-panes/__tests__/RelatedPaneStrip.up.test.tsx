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

import {
  AuthorityHarness,
  authoritySwitch,
  settledStorageSnapshot,
} from '../../contexts/__tests__/paneRelationsHarness';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { PaneRelationsProvider } from '../../contexts/PaneRelationsContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { writePaneFence } from '../../regions/pane-fence';
import {
  PANE_RELATIONS_STORAGE_KEY,
  type PaneOpener,
  type PaneRelation,
  serializePaneRelations,
} from '../../regions/pane-relations';
import { writeFilePreviewPaneState } from '../filePreviewPaneStateStorage';
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

function seedRelation(
  opener: PaneOpener,
  stationId = 'station-a',
  generation = 'builtin',
) {
  const relation: PaneRelation = {
    instanceId: ID,
    stateKey: ID,
    stationId,
    generation,
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

describe('Up to a plugin opener', () => {
  const OPENER_PANE = `plugin-pane:${'c'.repeat(32)}`;
  const opener = (
    occurrenceId: string,
    layoutSlug: string | null,
  ): PaneOpener => ({
    occurrenceId,
    label: 'Reports',
    source: { kind: 'plugin-occurrence', projectSlug: 'alpha', layoutSlug },
  });

  test('a Project layout tab: Up goes to that layout through canonical navigation', async () => {
    seedRelation(opener('instance:plugin:alpha-id:list', 'reports'));
    mount();
    act(() => screen.getByRole('button', { name: 'Up to Reports' }).click());
    await waitFor(() =>
      expect(window.location.pathname).toBe('/projects/alpha/layouts/reports'),
    );
  });

  test('with no layout, Up goes to its Project', async () => {
    seedRelation(opener('instance:plugin:alpha-id:list', null));
    mount();
    act(() => screen.getByRole('button', { name: 'Up to Reports' }).click());
    await waitFor(() =>
      expect(window.location.pathname.startsWith('/projects/alpha')).toBe(true),
    );
  });

  test('an opener a region holds is revealed there, exactly', async () => {
    seedRelation(opener(OPENER_PANE, 'reports'));
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => {
      model?.placeSurface(OPENER_PANE, 'right');
      model?.placeSurface('activity', 'right');
    });
    expect(model?.regions.right.occupant).toBe('activity');
    act(() => screen.getByRole('button', { name: 'Up to Reports' }).click());
    await waitFor(() =>
      expect(model?.regions.right.occupant).toBe(OPENER_PANE),
    );
    expect(window.location.pathname).toBe('/');
  });
});

describe('Up to an exact Project plugin pane', () => {
  const projectOpener = {
    occurrenceId: 'instance:plugin:alpha-id:reports',
    label: 'Reports',
    source: {
      kind: 'plugin-occurrence',
      projectSlug: 'alpha',
      layoutSlug: null,
      projectPane: {
        descriptorId: 'pane:plugin%3Areports:list',
        instanceId: 'instance:plugin:alpha-id:reports',
      },
    },
  } satisfies PaneOpener;
  const path =
    '/projects/alpha/panes/pane%3Aplugin%253Areports%3Alist/instance%3Aplugin%3Aalpha-id%3Areports';

  test('desktop Up already on its exact route creates no history or popstate', async () => {
    navigationStore.navigate(path);
    seedRelation(projectOpener);
    mount();
    const length = window.history.length;
    const pop = vi.fn();
    window.addEventListener('popstate', pop);
    try {
      act(() => screen.getByRole('button', { name: 'Up to Reports' }).click());
      await act(async () => {
        await Promise.resolve();
      });
      expect(window.history.length).toBe(length);
      expect(pop).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('popstate', pop);
    }
  });

  test.each([
    'cancel',
    'station-change',
    'station-and-record-change',
    'generation-change',
    'source-change',
    'new-guard',
    'allow',
  ])(
    'a routed exact return rechecks %s and commits only through canonical navigation',
    async (answer) => {
      seedRelation(projectOpener);
      mount();
      let proceed: (() => void) | undefined;
      const unregister = navigationStore.registerNavigationGuard(
        Symbol('exact Up'),
        (accept, cancel) => {
          if (answer === 'cancel') cancel?.();
          else proceed = accept;
        },
        ID,
      );
      let unregisterNew = () => {};
      try {
        await settledStorageSnapshot();
        const up = screen.getByRole('button', { name: 'Up to Reports' });
        act(() => up.click());
        if (answer !== 'cancel')
          await waitFor(() => expect(proceed).toBeDefined());
        if (answer === 'station-change')
          await act(async () => {
            authoritySwitch.set?.({ station: 'station-b' });
          });
        if (
          answer === 'station-and-record-change' ||
          answer === 'generation-change'
        ) {
          act(() => {
            if (answer === 'station-and-record-change')
              authoritySwitch.set?.({ station: 'station-b' });
            seedRelation(
              projectOpener,
              answer === 'station-and-record-change'
                ? 'station-b'
                : 'station-a',
              answer === 'generation-change' ? 'changed-generation' : 'builtin',
            );
            window.dispatchEvent(
              new StorageEvent('storage', {
                key: PANE_RELATIONS_STORAGE_KEY,
                newValue: localStorage.getItem(PANE_RELATIONS_STORAGE_KEY),
              }),
            );
          });
          expect(screen.getByRole('button', { name: 'Up to Reports' })).toBe(
            up,
          );
        }
        if (answer === 'source-change')
          await act(async () => {
            const changed = {
              ...projectOpener,
              source: { ...projectOpener.source, projectSlug: 'beta' },
            };
            seedRelation(changed);
            window.dispatchEvent(
              new StorageEvent('storage', {
                key: PANE_RELATIONS_STORAGE_KEY,
                newValue: localStorage.getItem(PANE_RELATIONS_STORAGE_KEY),
              }),
            );
          });
        if (answer === 'new-guard')
          unregisterNew = navigationStore.registerNavigationGuard(
            Symbol('new work'),
            (accept) => accept(),
            ID,
          );
        const before = await settledStorageSnapshot();
        await act(async () => {
          proceed?.();
        });
        if (answer === 'allow')
          await waitFor(() => expect(window.location.pathname).toBe(path));
        else {
          expect(window.location.pathname).toBe('/');
          expect(await settledStorageSnapshot()).toEqual(before);
        }
      } finally {
        unregisterNew();
        unregister();
      }
    },
  );

  test('same-path phone Up asks once and Cancel leaves the actual child layer intact', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    window.history.replaceState({}, '', path);
    navigationStore.navigate(path);
    seedRelation(projectOpener);
    writeFilePreviewPaneState(localStorage, ID, {
      version: '1.0',
      projectSlug: 'alpha',
      path: 'a.ts',
      wrap: true,
    });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => {
      model?.openSurfaceInRegion(ID);
    });
    await waitFor(() => expect(model?.phoneLayer?.surfaceId).toBe(ID));
    let accept = false;
    let asked = 0;
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('phone exact Up'),
      (proceed, cancel) => {
        asked += 1;
        if (accept) proceed();
        else cancel?.();
      },
      ID,
    );
    const before = await settledStorageSnapshot();
    const up = screen.getByRole('button', { name: 'Up to Reports' });
    act(() => {
      up.focus();
      up.click();
    });
    expect(asked).toBe(1);
    expect(model?.phoneLayer?.surfaceId).toBe(ID);
    expect(await settledStorageSnapshot()).toEqual(before);
    expect(document.activeElement).toBe(up);
    accept = true;
    const pushes = vi.spyOn(window.history, 'pushState');
    act(() => up.click());
    await waitFor(() => expect(model?.phoneLayer).toBeNull());
    expect(window.location.pathname).toBe(path);
    expect(asked).toBe(2);
    expect(pushes).not.toHaveBeenCalled();
    pushes.mockRestore();
    unregister();
  });

  test.each([
    { descriptorId: '', instanceId: 'instance:plugin:alpha-id:reports' },
    {
      descriptorId: 'pane:plugin%3Areports:list',
      instanceId: 'different-instance',
    },
    {
      descriptorId: ' pane:plugin%3Areports:list',
      instanceId: 'instance:plugin:alpha-id:reports',
    },
  ])(
    'an invalid exact pane reference does not silently offer a Project fallback: %j',
    (projectPane) => {
      seedRelation({
        ...projectOpener,
        source: { ...projectOpener.source, projectPane },
      });
      mount();
      expect(
        screen.queryByRole('button', { name: 'Up to Reports' }),
      ).toBeNull();
    },
  );
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

/**
 * Up selects things no route navigation guards — Chat's conversation, a
 * revealed surface. When that reveal takes the related pane itself off
 * screen, the pane's own unsaved-changes guard is asked once, before
 * anything changes, and Cancel leaves the source, the pane and the focus as
 * they were. When the pane stays on screen nothing is asked.
 */
describe('Up and the related pane’s unsaved work', () => {
  const RELEASE: PaneOpener = {
    occurrenceId: 'chat',
    label: 'Release review',
    source: {
      kind: 'conversation',
      conversationId: 'conversation-release',
      threadId: null,
      projectSlug: 'alpha',
    },
  };

  function dirtyChild(answer: () => 'cancel' | 'continue') {
    let asked = 0;
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('dirty related pane'),
      (continueNavigation, cancel) => {
        asked += 1;
        if (answer() === 'cancel') cancel?.();
        else continueNavigation();
      },
      ID,
    );
    return { asked: () => asked, unregister };
  }

  async function placeChild(region: 'right' | 'bottom') {
    writeFilePreviewPaneState(localStorage, ID, {
      version: '1.0',
      projectSlug: 'alpha',
      path: 'src/a.ts',
      wrap: true,
    });
    await waitFor(() => expect(model).not.toBeNull());
    act(() => {
      model?.openSurfaceInRegion('chat', { region: 'bottom' });
    });
    act(() => {
      model?.openSurfaceInRegion(ID, { region });
    });
    await waitFor(() => expect(model?.regions[region].occupant).toBe(ID));
  }

  test('desktop, the pane shares Chat’s region: asked once; Cancel changes nothing, continue shows the conversation', async () => {
    seedRelation(RELEASE);
    mount();
    await placeChild('bottom');
    act(() => navigationStore.setActiveChat('conversation-other'));
    let reply: 'cancel' | 'continue' = 'cancel';
    const guard = dirtyChild(() => reply);
    try {
      const up = screen.getByRole('button', { name: 'Up to Release review' });
      act(() => up.focus());
      const arrangement = structuredClone(model?.regions);
      act(() => up.click());
      expect(guard.asked()).toBe(1);
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-other',
      );
      expect(model?.regions).toEqual(arrangement);
      expect(document.activeElement).toBe(up);

      reply = 'continue';
      act(() => up.click());
      expect(guard.asked()).toBe(2);
      await waitFor(() =>
        expect(navigationStore.getSnapshot().activeChat).toBe(
          'conversation-release',
        ),
      );
      expect(model?.regions.bottom.occupant).toBe('chat');
    } finally {
      guard.unregister();
    }
  });

  test('desktop, the pane is in Related while Chat is in Tools: nothing is asked and the pane stays', async () => {
    seedRelation(RELEASE);
    mount();
    await placeChild('right');
    const guard = dirtyChild(() => 'cancel');
    try {
      act(() =>
        screen.getByRole('button', { name: 'Up to Release review' }).click(),
      );
      await waitFor(() =>
        expect(navigationStore.getSnapshot().activeChat).toBe(
          'conversation-release',
        ),
      );
      expect(guard.asked()).toBe(0);
      expect(model?.regions.right.occupant).toBe(ID);
    } finally {
      guard.unregister();
    }
  });

  test('Files in the pane’s own region: asked before Files is revealed; Cancel leaves the pane selected', async () => {
    deviceSettingsStore.set('chatDockProjectSlug', 'alpha');
    seedRelation({
      occurrenceId: 'coding:file-browser',
      label: 'Files · Alpha',
      source: { kind: 'files', projectId: 'alpha-id', projectSlug: 'alpha' },
    });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => {
      model?.openSurfaceInRegion('coding:file-browser', { region: 'right' });
    });
    await placeChild('right');
    let reply: 'cancel' | 'continue' = 'cancel';
    const guard = dirtyChild(() => reply);
    try {
      const up = screen.getByRole('button', { name: 'Up to Files · Alpha' });
      act(() => up.click());
      expect(guard.asked()).toBe(1);
      expect(model?.regions.right.occupant).toBe(ID);
      reply = 'continue';
      act(() => up.click());
      await waitFor(() =>
        expect(model?.regions.right.occupant).toBe('coding:file-browser'),
      );
    } finally {
      guard.unregister();
    }
  });
});

describe('Up from a pane shown over Chat on a phone', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    window.history.replaceState({}, '', '/?dock=open');
    navigationStore.navigate('/', { dock: 'open', maximize: null });
  });

  test('the layer’s own guard is asked once; Cancel keeps the layer and the conversation, continue returns to the opener', async () => {
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
    writeFilePreviewPaneState(localStorage, ID, {
      version: '1.0',
      projectSlug: 'alpha',
      path: 'src/a.ts',
      wrap: true,
    });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => navigationStore.setActiveChat('conversation-other'));
    act(() => {
      model?.openSurfaceInRegion(ID);
    });
    await waitFor(() => expect(model?.phoneLayer?.surfaceId).toBe(ID));
    let asked = 0;
    let reply: 'cancel' | 'continue' = 'cancel';
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('dirty layer pane'),
      (continueNavigation, cancel) => {
        asked += 1;
        if (reply === 'cancel') cancel?.();
        else continueNavigation();
      },
      ID,
    );
    try {
      const up = screen.getByRole('button', { name: 'Up to Release review' });
      act(() => up.click());
      expect(asked).toBe(1);
      expect(model?.phoneLayer?.surfaceId).toBe(ID);
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-other',
      );

      reply = 'continue';
      act(() => up.click());
      expect(asked).toBe(2);
      await waitFor(() => expect(model?.phoneLayer).toBeNull());
      expect(navigationStore.getSnapshot().activeChat).toBe(
        'conversation-release',
      );
    } finally {
      unregister();
    }
  });
});
