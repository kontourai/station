/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getLegacyPathRedirect,
  resolveViewFromPath,
} from '../app-shell/routing';
import { DIALOG_HISTORY_KEY } from '../components/dialog-history';
import {
  navigationStore,
  parseNavigationTarget,
  parseProjectSelectionFromPath,
} from '../contexts/navigation-store';
import { handleUiNavigate } from '../hooks/useServerEvents';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { normalizeDockMode } from '../types';

describe('parseProjectSelectionFromPath', () => {
  test('keeps the new-project route outside project context', () => {
    expect(parseProjectSelectionFromPath('/projects/new')).toEqual({
      selectedProject: null,
      selectedProjectLayout: null,
    });
  });

  test.each([
    ['/projects/demo', 'demo', null],
    ['/projects/demo/edit', 'demo', null],
    ['/projects/demo/layouts/coding', 'demo', 'coding'],
    [
      '/projects/demo/layouts/coding/panes/pane%3Abuiltin%3Acoding%3Afile-browser/files-1',
      'demo',
      'coding',
    ],
  ])(
    'preserves project selection for %s',
    (pathname, selectedProject, selectedProjectLayout) => {
      expect(parseProjectSelectionFromPath(pathname)).toEqual({
        selectedProject,
        selectedProjectLayout,
      });
    },
  );
});

describe('navigationStore dialog history isolation', () => {
  test('does not carry a dialog Back marker into a new route entry', () => {
    window.history.replaceState({ [DIALOG_HISTORY_KEY]: 'new-chat' }, '', '/');

    navigationStore.navigate('/connections/models');

    expect(window.location.pathname).toBe('/connections/models');
    expect(window.history.state[DIALOG_HISTORY_KEY]).toBeUndefined();
  });

  test('commits a same-route chat selection beyond the dialog Back marker', () => {
    window.history.replaceState(
      { [DIALOG_HISTORY_KEY]: 'new-chat' },
      '',
      '/projects/alpha?chat=conversation-old',
    );

    navigationStore.navigate('/projects/alpha', {
      chat: 'session-new',
    });

    expect(window.location.pathname).toBe('/projects/alpha');
    expect(new URLSearchParams(window.location.search).get('chat')).toBe(
      'session-new',
    );
    expect(window.history.state[DIALOG_HISTORY_KEY]).toBeUndefined();
  });
});

describe('navigationStore Settings query history', () => {
  test('retains the index through query normalization, exempts Settings Back, and guards route leave', async () => {
    window.history.replaceState({}, '', '/settings');
    window.dispatchEvent(new PopStateEvent('popstate'));
    navigationStore.updateParams({ dock: 'open' });
    expect(window.history.state.__stationNavigationIndex).toEqual(
      expect.any(Number),
    );

    navigationStore.navigate('/settings?dock=open&view=system');
    navigationStore.navigate('/settings?dock=open&view=appearance');
    const guard = vi.fn((continueNavigation: () => void) =>
      continueNavigation(),
    );
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('settings-draft'),
      guard,
    );
    const restored = new Promise<void>((resolve) => {
      const unsubscribe = navigationStore.subscribe(() => {
        if (window.location.search.includes('view=system')) {
          unsubscribe();
          resolve();
        }
      });
    });

    window.history.back();
    await restored;
    expect(guard).not.toHaveBeenCalled();
    expect(window.location.search).toContain('view=system');
    navigationStore.navigate('/connections');
    expect(guard).toHaveBeenCalledOnce();
    unregister();
  });
});

describe('navigationStore legacy Activity canonicalization', () => {
  test('rewrites a legacy /sessions deep link before deriving navigation state', () => {
    window.history.replaceState({}, '', '/sessions?session=x&anything=y');

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(window.location.pathname + window.location.search).toBe(
      '/activity?session=x&anything=y',
    );
    expect(navigationStore.getSnapshot().pathname).toBe('/activity');
  });
});

describe('navigationStore Workspace Pane selection history', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/projects/demo/layouts/coding');
    navigationStore.navigate('/projects/demo/layouts/coding', { pane: null });
  });

  test('deep links, selections, Back, and Forward update the same snapshot', async () => {
    const listener = vi.fn();
    const unsubscribe = navigationStore.subscribe(listener);
    navigationStore.setActiveWorkspacePane('one', 'project:demo:coding');
    navigationStore.setActiveWorkspacePane('two', 'project:demo:coding');
    expect(navigationStore.getSnapshot().activeWorkspacePane).toBe('two');
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      window.history.back();
    });
    expect(navigationStore.getSnapshot().activeWorkspacePane).toBe('one');
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      window.history.forward();
    });
    expect(navigationStore.getSnapshot().activeWorkspacePane).toBe('two');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  test('keeps a layout-qualified pane route out of the layout tab selection', () => {
    navigationStore.navigate(
      '/projects/demo/layouts/coding/panes/pane%3Abuiltin%3Acoding%3Aterminal/workspace-coding-terminal',
    );

    expect(navigationStore.getSnapshot()).toMatchObject({
      selectedProject: 'demo',
      selectedProjectLayout: 'coding',
      selectedLayout: 'coding',
      activeTab: null,
    });
  });

  test('restores a layout-qualified Coding pane through browser history', async () => {
    const panePath =
      '/projects/demo/layouts/coding/panes/pane%3Abuiltin%3Acoding/coding-1';
    navigationStore.navigate(panePath);
    navigationStore.navigate('/projects/demo');

    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      window.history.back();
    });

    expect(navigationStore.getSnapshot()).toMatchObject({
      pathname: panePath,
      selectedProject: 'demo',
      selectedProjectLayout: 'coding',
      selectedLayout: 'coding',
      activeTab: null,
    });
  });
});

describe('navigationStore File Preview intent', () => {
  test('parses and serializes the canonical exact path and range', () => {
    navigationStore.navigate('/projects/demo/layouts/coding', {
      previewPath: 'src/App.tsx',
      previewLineStart: '12',
      previewLineEnd: '18',
    });
    expect(navigationStore.getSnapshot().openFilePreviewIntent).toEqual({
      projectSlug: 'demo',
      path: 'src/App.tsx',
      lineRange: { start: 12, end: 18 },
    });

    navigationStore.setLayout('demo', 'coding', {
      openFilePreviewIntent: {
        projectSlug: 'demo',
        path: 'src/App.tsx',
        lineRange: { start: 12, end: 18 },
      },
    });
    expect(new URL(window.location.href).search).toContain(
      'previewPath=src%2FApp.tsx',
    );
  });
});

describe('normalizeDockMode (legacy persisted-value migration, #1043)', () => {
  test('passes current modes through', () => {
    expect(normalizeDockMode('left')).toBe('left');
    expect(normalizeDockMode('bottom')).toBe('bottom');
    expect(normalizeDockMode('right')).toBe('right');
  });

  test("maps the retired 'bottom-inline' name to 'bottom'", () => {
    expect(normalizeDockMode('bottom-inline')).toBe('bottom');
  });

  test('rejects junk, null, and undefined', () => {
    expect(normalizeDockMode('floating')).toBeNull();
    expect(normalizeDockMode('')).toBeNull();
    expect(normalizeDockMode(null)).toBeNull();
    expect(normalizeDockMode(undefined)).toBeNull();
  });
});

/**
 * archive#settings-revamp (docs/design/settings-architecture.md §3
 * "Chat/session", §6): `parseUrl`'s `dockMode` resolution gains
 * a device-scope fallback, and `setDockMode` (the convergence point for
 * both ⌘⇧M and the chat settings panel) writes it on every explicit choice.
 * Precedence pinned here: URL param > device setting > registry default.
 */
describe('navigationStore dockMode device-scope fallback', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    navigationStore.dockModeOverride = null;
    navigationStore.navigate('/', { dockSlotPlacement: null });
  });

  afterEach(() => {
    deviceSettingsStore.reset('dockSlotPlacement');
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    navigationStore.dockModeOverride = null;
  });

  test('falls back to the remembered dock-slot placement when no URL param is present', () => {
    deviceSettingsStore.set('dockSlotPlacement', 'right');

    navigationStore.navigate('/', {});

    expect(navigationStore.getSnapshot().dockMode).toBe('right');
  });

  test('an explicit URL param wins over the device-scope setting', () => {
    deviceSettingsStore.set('dockSlotPlacement', 'right');

    navigationStore.navigate('/', { dockSlotPlacement: 'bottom' });

    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');
  });

  test('falls back to "bottom" when neither a URL param nor a device setting is present', () => {
    navigationStore.navigate('/', {});

    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');
  });

  test('setDockMode() writes both the URL param (existing behavior) and the device-scope default', () => {
    navigationStore.setDockMode('right');

    expect(navigationStore.getSnapshot().dockMode).toBe('right');
    expect(
      new URL(window.location.href).searchParams.get('dockSlotPlacement'),
    ).toBe('right');
    expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('right');
  });

  test('persists left as a first-class URL and device preference', () => {
    navigationStore.setDockMode('left');

    expect(navigationStore.getSnapshot().dockMode).toBe('left');
    expect(
      new URL(window.location.href).searchParams.get('dockSlotPlacement'),
    ).toBe('left');
    expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('left');
  });

  test('a later navigation with no URL param and no in-memory override picks up the persisted device default (last-set-wins-across-sessions)', () => {
    navigationStore.setDockMode('right');

    // Simulate a fresh navigation with neither an explicit URL param nor a
    // layout's quiet override in play (e.g. a reload of a non-layout route).
    navigationStore.dockModeOverride = null;
    navigationStore.navigate('/', { dockSlotPlacement: null });

    expect(navigationStore.getSnapshot().dockMode).toBe('right');
  });
});

/**
 * archive#settings-revamp: `parseUrl` only ran
 * at navigation time, so an external device-store change (Settings →
 * Import, or a cross-tab write) never reached a mounted view's `dockMode`
 * until the next unrelated navigation happened to re-run it. `navigationStore`
 * now subscribes to `deviceSettingsStore` directly (see the constructor and
 * `handleDeviceSettingsChange`) — these tests drive that subscription with
 * NO navigation in between the store write and the assertion.
 */
describe('navigationStore dockMode subscribes to live device-store changes (slice 4 review finding 1)', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    navigationStore.dockModeOverride = null;
    navigationStore.navigate('/', { dockSlotPlacement: null });
  });

  afterEach(() => {
    deviceSettingsStore.reset('dockSlotPlacement');
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    navigationStore.dockModeOverride = null;
  });

  test('a device-store change updates the resolved dockMode with NO navigation, when no URL param or override governs', () => {
    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');

    deviceSettingsStore.set('dockSlotPlacement', 'right');

    expect(navigationStore.getSnapshot().dockMode).toBe('right');
  });

  test('a device-store change is a no-op when an explicit URL param already governs', () => {
    navigationStore.navigate('/', { dockSlotPlacement: 'bottom' });
    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');

    deviceSettingsStore.set('dockSlotPlacement', 'right');

    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');
  });

  test('a device-store change is a no-op when dockModeOverride (a layout quiet preference) already governs', () => {
    navigationStore.setDockModeQuiet('right');
    expect(navigationStore.getSnapshot().dockMode).toBe('right');

    deviceSettingsStore.set('dockSlotPlacement', 'bottom');

    // dockModeOverride still governs — unaffected by the device-store write.
    expect(navigationStore.getSnapshot().dockMode).toBe('right');
  });

  test('a cross-tab storage event for the device envelope updates the resolved dockMode', () => {
    expect(navigationStore.getSnapshot().dockMode).toBe('bottom');

    const externalEnvelope = {
      version: 2,
      values: { dockSlotPlacement: 'right' },
    };
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify(externalEnvelope),
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'station-device-settings-v1',
        newValue: JSON.stringify(externalEnvelope),
        storageArea: localStorage,
      }),
    );

    expect(navigationStore.getSnapshot().dockMode).toBe('right');
  });

  test('a same-value device-store change does not notify subscribers (no-op propagates from the store)', () => {
    // Registry default is already 'bottom' — set is a true no-op.
    const listener = vi.fn();
    const unsubscribe = navigationStore.subscribe(listener);

    deviceSettingsStore.set('dockSlotPlacement', 'bottom');

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('navigationStore route-change query hygiene (6-OPS-30)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    navigationStore.navigate('/');
  });

  test('drops the source route’s params when the pathname changes', () => {
    // Measured, three independent instances in one run:
    //   /settings?view=notifications  → /notifications?view=notifications
    //   /settings?view=knowledge      → /connections/knowledge?view=knowledge
    //   /settings?view=developer-tools → ⌘K → /activity?view=developer-tools
    // Harmless only while the destination ignores what it inherited;
    // /notifications already reads ?category= from the URL.
    window.history.replaceState({}, '', '/settings?view=notifications');
    navigationStore.navigate('/notifications');
    expect(window.location.pathname + window.location.search).toBe(
      '/notifications',
    );

    window.history.replaceState({}, '', '/settings?view=developer-tools');
    navigationStore.navigate('/activity');
    expect(window.location.search).toBe('');
  });

  test('keeps a param the caller supplies for the destination', () => {
    window.history.replaceState({}, '', '/settings?view=appearance');
    navigationStore.navigate('/activity', { session: 'thread-1' });
    expect(window.location.pathname + window.location.search).toBe(
      '/activity?session=thread-1',
    );
  });

  test('keeps shell-scoped params, which describe the dock and not the route', () => {
    // The chat dock is persistent chrome: it does not close, un-maximize or
    // change font size because the page behind it changed.
    window.history.replaceState(
      {},
      '',
      '/settings?view=appearance&dock=open&maximize=true&fontSize=15',
    );
    navigationStore.navigate('/registry');
    const params = new URLSearchParams(window.location.search);
    expect(window.location.pathname).toBe('/registry');
    expect(params.get('dock')).toBe('open');
    expect(params.get('maximize')).toBe('true');
    expect(params.get('fontSize')).toBe('15');
    expect(params.get('view')).toBeNull();
  });

  test('leaves the query alone when only params change on the same route', () => {
    window.history.replaceState({}, '', '/settings?view=appearance');
    navigationStore.navigate('/settings', { highlight: 'theme' });
    const params = new URLSearchParams(window.location.search);
    expect(params.get('view')).toBe('appearance');
    expect(params.get('highlight')).toBe('theme');
  });

  test.each([
    ['web', 'http://localhost/agents/new'],
    ['Tauri', 'tauri://localhost/agents/new'],
  ])(
    'keeps an internal query target out of the pathname on %s',
    (_platform, base) => {
      const target = parseNavigationTarget(
        '/connections?section=engines',
        base,
      );
      expect(target.pathname).toBe('/connections');
      expect(target.searchParams.get('section')).toBe('engines');
    },
  );

  test.each([
    ['web', 'http://localhost/agents/new'],
    ['Tauri', 'tauri://localhost/agents/new'],
  ])('preserves repeated destination params on %s', (_platform, base) => {
    const target = parseNavigationTarget(
      '/notifications?category=a&category=b',
      base,
    );
    expect(target.searchParams.getAll('category')).toEqual(['a', 'b']);
  });

  test('preserves repeated params through direct navigation and ui:navigate', () => {
    navigationStore.navigate('/notifications?category=a&category=b');
    expect(
      new URL(window.location.href).searchParams.getAll('category'),
    ).toEqual(['a', 'b']);

    handleUiNavigate({ path: '/notifications?category=c&category=d' });
    expect(
      new URL(window.location.href).searchParams.getAll('category'),
    ).toEqual(['c', 'd']);
  });

  test('structured params deliberately override every repeated destination value', () => {
    navigationStore.navigate('/notifications?category=a&category=b', {
      category: 'override',
    });
    expect(
      new URL(window.location.href).searchParams.getAll('category'),
    ).toEqual(['override']);
  });

  test('routes the Agent editor engine setup target to the Engines section', () => {
    navigationStore.navigate('/connections?section=engines');

    expect(window.location.pathname + window.location.search).toBe(
      '/connections/engines',
    );
    expect(navigationStore.getSnapshot().pathname).toBe('/connections/engines');
    expect(
      resolveViewFromPath(
        getLegacyPathRedirect('/connections?section=engines')!,
      ),
    ).toEqual({ type: 'connections-engines' });
  });
});
