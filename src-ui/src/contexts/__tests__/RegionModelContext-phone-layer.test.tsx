/** @vitest-environment jsdom */

/**
 * The phone layer through the real provider, navigation store and history:
 * on a phone (coarse pointer, 390px), a pane opened with no region — or with
 * a side region the fold does not offer — opens OVER Chat as a selected,
 * maximized tab of Chat's region, pushes one history entry, and Back (the
 * device's, or `closePhoneLayer`) returns to Chat with the region restored
 * and the minted tab removed. The pure rules are
 * `region-model-phone-layer.test.ts`; the "‹ Chat" control's wiring is
 * `RegionPaneHost.phoneLayer.test.tsx`; the chat link that starts it is the
 * last describe here.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DIALOG_HISTORY_KEY } from '../../components/dialog-history';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

// The anchor reads a pull request's forge state through the SDK; the link
// test below only needs it to answer "nothing known".
vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: () => ({ data: undefined }),
}));

import { ChatMarkdownAnchor } from '../../components/chat/ChatMarkdownAnchor';
import { MarkdownLinkContext } from '../../components/chat/MarkdownLinkContext';

const PR = 'pr:github.com/kontourai/station#2049';
const OTHER_PR = 'pr:github.com/kontourai/station#2050';

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function current() {
  if (!model) throw new Error('probe never rendered');
  return model;
}

function stubDevice({ phone }: { phone: boolean }) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: phone ? 390 : 1024,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      phone && (query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

async function mount(children?: React.ReactNode) {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          {children}
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(model).not.toBeNull());
  // Chat reading, docked, before anything opens over it.
  await waitFor(() =>
    expect(current().regions.bottom).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
      maximized: false,
    }),
  );
}

function onLayerEntry(): boolean {
  const state = window.history.state as Record<string, unknown> | null;
  const marker = state?.[DIALOG_HISTORY_KEY];
  return typeof marker === 'string' && marker.startsWith('phone-pane-layer:');
}

function maximizeParam(): string | null {
  return new URLSearchParams(window.location.search).get('maximize');
}

beforeEach(() => {
  model = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', {
    dock: 'open',
    maximize: null,
    dockSlotPlacement: null,
  });
  stubDevice({ phone: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  navigationStore.navigate('/', { dock: null, dockSlotPlacement: null });
});

describe('a pane opened on a phone opens over Chat', () => {
  test('as a selected, maximized tab of Chat’s region, with one history entry', async () => {
    await mount();
    const pushes = vi.spyOn(window.history, 'pushState');
    let outcome: unknown;
    act(() => {
      outcome = current().openSurfaceInRegion(PR);
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'bottom',
      surfaceId: PR,
      existing: false,
    });
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat', PR],
        occupant: PR,
        visible: true,
        maximized: true,
      }),
    );
    // No side region was taken and nothing was folded away.
    expect(current().regions.right.panes).toEqual([]);
    expect(current().phoneLayer).toEqual({ region: 'bottom', surfaceId: PR });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    expect(pushes).toHaveBeenCalledTimes(1);
    // The maximize is Chat's region's, so navigation mirrors it.
    await waitFor(() => expect(maximizeParam()).toBe('true'));
  });

  test('a side region the fold does not offer opens over Chat instead of being refused', async () => {
    await mount();
    let outcome: unknown;
    act(() => {
      outcome = current().openSurfaceInRegion(PR, { region: 'right' });
    });
    // Before the phone layer this was `region-unavailable`.
    expect(outcome).toMatchObject({ ok: true, region: 'bottom' });
    await waitFor(() => expect(current().regions.bottom.occupant).toBe(PR));
  });

  test('the device’s Back returns to Chat: selected, docked again, the minted tab gone', async () => {
    await mount();
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    await waitFor(() => expect(maximizeParam()).toBe('true'));
    act(() => window.history.back());
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        visible: true,
        maximized: false,
      }),
    );
    expect(current().phoneLayer).toBeNull();
    // The URL is the pre-layer one: no maximize, no marker.
    await waitFor(() => expect(maximizeParam()).toBeNull());
    expect(onLayerEntry()).toBe(false);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
  });

  // Review L1: the layer's maximize is mirrored into `lastDockMaximized`.
  // "‹ Chat" wrote it back through the mirror; Back did not, so the next
  // `focusSession` reopened Chat Full after a single look at a pane.
  test('Back leaves the maximize memory as the layer found it, the same as "‹ Chat"', async () => {
    navigationStore.setDockState(true, false);
    await mount();
    expect(navigationStore.lastDockMaximized).toBe(false);
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    await waitFor(() => expect(maximizeParam()).toBe('true'));
    expect(navigationStore.lastDockMaximized).toBe(true);
    act(() => window.history.back());
    await waitFor(() => expect(current().regions.bottom.occupant).toBe('chat'));
    await waitFor(() => expect(navigationStore.lastDockMaximized).toBe(false));

    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    act(() => current().closePhoneLayer());
    await waitFor(() => expect(current().regions.bottom.occupant).toBe('chat'));
    expect(navigationStore.lastDockMaximized).toBe(false);
  });

  test('a Chat that was maximized comes back maximized', async () => {
    window.history.replaceState({}, '', '/?dock=open&maximize=true');
    navigationStore.navigate('/', { dock: 'open', maximize: 'true' });
    render(
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegionModelProvider>
            <Probe />
          </RegionModelProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>,
    );
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        occupant: 'chat',
        maximized: true,
      }),
    );
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    act(() => window.history.back());
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        maximized: true,
      }),
    );
    expect(maximizeParam()).toBe('true');
  });

  /**
   * A layer over a HIDDEN Chat region shows the region maximized and hides
   * it again on Back. The archive#945 close rule forwards the maximize a
   * region closes FROM as `lastDockMaximized`, which here would be the
   * layer's own — and the next `focusSession` would reopen Chat Full though
   * the user never asked for it. The memory the layer found must survive.
   */
  test('over a hidden Chat, Back hides the region again and leaves the maximize memory as it was', async () => {
    window.history.replaceState({}, '', '/');
    navigationStore.navigate('/', { dock: null, maximize: null });
    navigationStore.lastDockMaximized = false;
    render(
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegionModelProvider>
            <Probe />
          </RegionModelProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>,
    );
    await waitFor(() => expect(model).not.toBeNull());
    expect(current().regions.bottom.visible).toBe(false);
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        occupant: PR,
        visible: true,
        maximized: true,
      }),
    );
    await waitFor(() => expect(maximizeParam()).toBe('true'));
    act(() => window.history.back());
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat'],
        visible: false,
      }),
    );
    await waitFor(() =>
      expect(navigationStore.getSnapshot().isDockOpen).toBe(false),
    );
    expect(navigationStore.lastDockMaximized).toBe(false);
  });

  test('a second pane opened over the first replaces it, and one Back still returns to Chat', async () => {
    await mount();
    const pushes = vi.spyOn(window.history, 'pushState');
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    act(() => {
      current().openSurfaceInRegion(OTHER_PR);
    });
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat', OTHER_PR],
        occupant: OTHER_PR,
        maximized: true,
      }),
    );
    // One layer, one entry.
    expect(pushes).toHaveBeenCalledTimes(1);
    act(() => window.history.back());
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        maximized: false,
      }),
    );
    expect(current().phoneLayer).toBeNull();
  });

  test('closePhoneLayer (the "‹ Chat" control) is the same way back, and consumes the entry', async () => {
    await mount();
    const stateBefore = window.history.state;
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    await waitFor(() => expect(maximizeParam()).toBe('true'));
    act(() => current().closePhoneLayer());
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        maximized: false,
      }),
    );
    await waitFor(() => expect(onLayerEntry()).toBe(false));
    expect(maximizeParam()).toBeNull();
    // Travelled back over the entry rather than collapsing it in place: the
    // live entry is the one before the layer's push, state and all (a
    // collapse would leave the marker's entry live, restamped with a new
    // navigation index, and a later Back would land on a duplicate).
    expect(window.history.state).toEqual(stateBefore);
  });

  test('switching to Chat from the menu dismisses the layer: minted tab removed, maximize undone, entry consumed', async () => {
    await mount();
    const stateBefore = window.history.state;
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    await waitFor(() => expect(maximizeParam()).toBe('true'));
    // The folded menu's "Show Chat in the dock" row is `toggleSurface`.
    act(() => current().toggleSurface('chat'));
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        maximized: false,
      }),
    );
    expect(current().phoneLayer).toBeNull();
    await waitFor(() => expect(onLayerEntry()).toBe(false));
    expect(maximizeParam()).toBeNull();
    // Consumed by travelling back, not collapsed into a residue entry.
    expect(window.history.state).toEqual(stateBefore);
  });

  // Review M1: the folded menu's "Hide <pane>" row is `toggleSurface`, whose
  // rule hides the folded region — which is Chat's. Hiding the layer's own
  // pane must be the way back to Chat instead.
  test('hiding the layer’s own pane returns to Chat rather than hiding Chat’s region', async () => {
    await mount();
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(onLayerEntry()).toBe(true));
    act(() => current().toggleSurface(PR));
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        panes: ['chat'],
        occupant: 'chat',
        visible: true,
        maximized: false,
      }),
    );
    expect(current().phoneLayer).toBeNull();
    await waitFor(() => expect(onLayerEntry()).toBe(false));
  });

  test('the layer is never persisted: the record holds the pre-layer arrangement', async () => {
    await mount();
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(current().regions.bottom.occupant).toBe(PR));
    // Past the persist debounce.
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    const stored = deviceSettingsStore.get('regionArrangement') as {
      bottom?: { panes?: string[] };
    } | null;
    expect(JSON.stringify(stored ?? {})).not.toContain(PR);
  });

  // Review M2: through the persisted record. A pane held in a hidden side
  // region is moved over Chat by the layer; the record written while the
  // layer is open, and after Back, must still hold it where it was.
  test('a pane from a hidden side region stays in that region in the record, during the layer and after Back', async () => {
    await mount();
    act(() => {
      current().placeSurface(PR, 'right');
      current().setRegion('right', { visible: false });
      current().selectPane('bottom', 'chat');
    });
    await waitFor(() =>
      expect(current().regions.right).toMatchObject({
        panes: [PR],
        visible: false,
      }),
    );
    const settle = () =>
      act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    await settle();
    const record = () =>
      JSON.stringify(deviceSettingsStore.get('regionArrangement'));
    const before = record();
    expect(before).toContain(PR);

    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(current().regions.bottom.occupant).toBe(PR));
    expect(current().regions.right.panes).toEqual([]);
    await settle();
    expect(record()).toBe(before);

    act(() => window.history.back());
    await waitFor(() => expect(current().regions.bottom.occupant).toBe('chat'));
    expect(current().regions.right).toMatchObject({
      panes: [PR],
      visible: false,
    });
    await settle();
    expect(record()).toBe(before);
  });

  // Review M3: a narrow fine-pointer window folds to one region too, and
  // widening it opens the fold. The layer must end there — no "‹ Chat" off a
  // fold — without unmounting the pane the user was reading.
  test('widening out of the fold ends the layer, keeping its pane as an ordinary tab', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 600,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === MOBILE_MEDIA_QUERY,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    await mount();
    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(current().phoneLayer).not.toBeNull());
    await waitFor(() => expect(onLayerEntry()).toBe(true));

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200,
    });
    act(() => window.dispatchEvent(new Event('resize')));
    await waitFor(() => expect(current().phoneLayer).toBeNull());
    expect(current().regions.bottom).toMatchObject({
      panes: ['chat', PR],
      occupant: PR,
      maximized: false,
    });
    await waitFor(() => expect(onLayerEntry()).toBe(false));
  });

  // Delta review M-b, as decided in round 4: the fold-open ending leaves a
  // pane the layer moved out of a hidden side region where the user is
  // looking at it — visible, selected, mounted (moving it back would remount
  // it and drop an unguarded draft) — but the RECORD must not lose it from
  // the region the user put it in: it projects the origin placement.
  test('widening out of the fold keeps a moved pane on screen, while the record keeps it in its region', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 600,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === MOBILE_MEDIA_QUERY,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    await mount();
    act(() => {
      current().placeSurface(PR, 'right');
      current().setRegion('right', { visible: false });
      current().selectPane('bottom', 'chat');
    });
    const settle = () =>
      act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    await settle();
    const record = () =>
      JSON.stringify(deviceSettingsStore.get('regionArrangement'));
    const before = record();
    expect(before).toContain(PR);

    act(() => {
      current().openSurfaceInRegion(PR);
    });
    await waitFor(() => expect(current().phoneLayer).not.toBeNull());
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200,
    });
    act(() => window.dispatchEvent(new Event('resize')));
    await waitFor(() => expect(current().phoneLayer).toBeNull());
    expect(current().regions.bottom).toMatchObject({
      panes: ['chat', PR],
      occupant: PR,
      visible: true,
      maximized: false,
    });
    expect(current().regions.right.panes).toEqual([]);
    await settle();
    expect(record()).toBe(before);
  });

  test('a fine-pointer desktop keeps its own rule: a side region, no layer, no history', async () => {
    stubDevice({ phone: false });
    await mount();
    const pushes = vi.spyOn(window.history, 'pushState');
    let outcome: unknown;
    act(() => {
      outcome = current().openSurfaceInRegion(PR);
    });
    expect(outcome).toMatchObject({ ok: true, region: 'right' });
    expect(current().phoneLayer).toBeNull();
    expect(pushes).not.toHaveBeenCalled();
  });
});

describe('a chat link on a phone opens its pane over Chat (supersedes #2049 B5)', () => {
  const LINK = {
    projectSlug: 'station',
    projectId: 'project-uuid',
    dockProjectSlug: 'station',
    openPathInMain: vi.fn(),
  };

  test('a pull request link opens the pull request pane, not the browser', async () => {
    await mount(
      <MarkdownLinkContext.Provider value={LINK}>
        <ChatMarkdownAnchor href="https://github.com/kontourai/station/pull/2049">
          #2049
        </ChatMarkdownAnchor>
      </MarkdownLinkContext.Provider>,
    );
    act(() => screen.getByRole('link', { name: /2049/ }).click());
    await waitFor(() =>
      expect(current().regions.bottom).toMatchObject({
        occupant: PR,
        maximized: true,
      }),
    );
    expect(current().phoneLayer).toEqual({ region: 'bottom', surfaceId: PR });
  });

  test('a path link opens a file preview pane, not the main route', async () => {
    await mount(
      <MarkdownLinkContext.Provider value={LINK}>
        <ChatMarkdownAnchor href="src/app.ts">src/app.ts</ChatMarkdownAnchor>
      </MarkdownLinkContext.Provider>,
    );
    act(() => screen.getByRole('link').click());
    await waitFor(() =>
      expect(current().regions.bottom.occupant).toMatch(/^file-preview:/),
    );
    expect(current().regions.bottom.maximized).toBe(true);
    expect(LINK.openPathInMain).not.toHaveBeenCalled();
  });
});
