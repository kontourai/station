/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RegionModelProvider as RegionModelProviderComponent } from '../contexts/RegionModelContext';
import type { useDockShellChrome as UseDockShellChromeFn } from '../hooks/useDockShellChrome';

const setDockState = vi.fn();
const setDockMode = vi.fn();
const collapseMaximizedDock = vi.fn();
let isDockOpen = true;
let isDockMaximized = false;
let dockMode: 'left' | 'bottom' | 'right' = 'bottom';
let pathname = '/';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    isDockOpen,
    isDockMaximized,
    dockMode,
    pathname,
    setDockState,
    setDockMode,
    collapseMaximizedDock,
  }),
}));

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
}));

// archive#4525: the project-deletion cleanup effect reads `useProjects`
// directly. Mocked (matching this file's existing `useNavigation` mock
// pattern) rather than wrapped in a real QueryClientProvider — this is a
// hook-unit test, not an integration test, and the mock lets each test
// control the pending/error/confirmed-loaded distinction precisely.
//
// Three independent knobs, mirroring the real `useProjects` shape
// (`ProjectsContext.tsx`) exactly: `isLoading` and `isConfirmedLoaded` are
// NOT simply each other's negation — the pending shape has both false-ish
// in different ways than the error shape does, and `useDockShellChrome`
// only ever reads `isConfirmedLoaded`. Defaulting it to `true` keeps every
// test that isn't specifically about the pending/error distinction reading
// as "steady state after a real, successful load" (archive#4525
// fix: `isConfirmedLoaded` requires POSITIVE evidence — a
// successful, error-free load with real data — never merely `!isLoading`,
// which the pre-fix guard used and which is ALSO true on error).
let projectsForDockShellChrome: { slug: string }[] = [];
let projectsLoadingForDockShellChrome = false;
let projectsConfirmedLoadedForDockShellChrome = true;

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: projectsForDockShellChrome,
    isLoading: projectsLoadingForDockShellChrome,
    isConfirmedLoaded: projectsConfirmedLoadedForDockShellChrome,
  }),
}));

async function freshUseDockShellChrome(): Promise<typeof UseDockShellChromeFn> {
  vi.resetModules();
  const mod = await import('../hooks/useDockShellChrome');
  return mod.useDockShellChrome;
}

/**
 * The same fresh-module import, plus the region model's own provider from the
 * SAME post-reset module registry — a provider imported before `resetModules`
 * would create a different `RegionModelContext` than the hook then reads, so
 * `useRegionModelOptional` would still see `null`.
 */
async function freshDockShellChromeInRegionModel(): Promise<{
  useDockShellChrome: typeof UseDockShellChromeFn;
  wrapper: ({ children }: { children: ReactNode }) => ReactNode;
}> {
  vi.resetModules();
  const chrome = await import('../hooks/useDockShellChrome');
  const region = await import('../contexts/RegionModelContext');
  const Provider =
    region.RegionModelProvider as typeof RegionModelProviderComponent;
  return {
    useDockShellChrome: chrome.useDockShellChrome,
    wrapper: ({ children }) => createElement(Provider, null, children),
  };
}

describe('useDockShellChrome', () => {
  beforeEach(() => {
    localStorage.clear();
    setDockState.mockClear();
    setDockMode.mockClear();
    collapseMaximizedDock.mockClear();
    isDockOpen = true;
    isDockMaximized = false;
    dockMode = 'bottom';
    pathname = '/';
    projectsForDockShellChrome = [];
    projectsLoadingForDockShellChrome = false;
    projectsConfirmedLoadedForDockShellChrome = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  test('dock height defaults to the device setting, clamped to the viewport', async () => {
    const useDockShellChrome = await freshUseDockShellChrome();
    const { result } = renderHook(() =>
      useDockShellChrome({
        publishesDockSlotClearance: true,
        registersDockShortcuts: true,
      }),
    );
    expect(result.current.dockHeight).toBe(320);
    expect(result.current.previousDockHeight).toBe(320);
  });

  test('restores and clamps persisted dock geometry to the current viewport', async () => {
    await freshUseDockShellChrome();
    const { deviceSettingsStore } = await import(
      '../lib/device-settings-store'
    );
    act(() => {
      deviceSettingsStore.set('chatDockHeight', 50_000);
      deviceSettingsStore.set('chatDockWidth', -500);
    });

    const restored = await freshUseDockShellChrome();
    const { result } = renderHook(() =>
      restored({
        publishesDockSlotClearance: true,
        registersDockShortcuts: true,
      }),
    );
    expect(result.current.dockHeight).toBe(window.innerHeight - 150);
    expect(result.current.dockWidth).toBe(280);
  });

  // #928 step 3b: drag release no longer writes `chatDockHeight` itself — it
  // writes the bottom region's size, and `RegionModelProvider`'s mirror is what
  // persists the device setting. The property this test exists for is unchanged
  // (no per-frame persistence; exactly one final write carrying the final
  // value), so it is asserted at the new seam: the hook inside a REAL region
  // model, still measured on the storage write.
  test('does not persist drag frames and writes the final height once on drag end', async () => {
    const { useDockShellChrome, wrapper } =
      await freshDockShellChromeInRegionModel();
    const { result } = renderHook(
      () =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      { wrapper },
    );
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');

    act(() => {
      result.current.setIsDragging(true);
      result.current.setDockHeight(350);
      result.current.setDockHeight(375);
      result.current.setDockHeight(410);
    });
    expect(storageWrite).not.toHaveBeenCalled();

    act(() => result.current.setIsDragging(false));
    expect(storageWrite).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(
      localStorage.getItem('station-device-settings-v1') || '{}',
    );
    expect(envelope.values.chatDockHeight).toBe(410);
  });

  describe('geometry authority', () => {
    test('reports the ambient dock slot size when visible and open', async () => {
      const useDockShellChrome = await freshUseDockShellChrome();
      const onGeometryChange = vi.fn();
      renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
          onRenderedRegionGeometryChange: onGeometryChange,
        }),
      );
      expect(onGeometryChange).toHaveBeenCalledWith('bottom', {
        size: 320,
        width: null,
      });
    });

    test('reports liveDragHeight instead of the committed dock height while dragging', async () => {
      const useDockShellChrome = await freshUseDockShellChrome();
      const onGeometryChange = vi.fn();
      const { result } = renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
          onRenderedRegionGeometryChange: onGeometryChange,
        }),
      );
      onGeometryChange.mockClear();
      act(() => result.current.setLiveDragHeight(512));
      expect(onGeometryChange).toHaveBeenCalledWith('bottom', {
        size: 512,
        width: null,
      });

      onGeometryChange.mockClear();
      act(() => result.current.setLiveDragHeight(null));
      expect(onGeometryChange).toHaveBeenCalledWith('bottom', {
        size: 320,
        width: null,
      });
    });

    test('a fullscreen Chat placement does not publish phantom dock-slot clearance', async () => {
      const useDockShellChrome = await freshUseDockShellChrome();
      const onGeometryChange = vi.fn();
      renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: false,
          registersDockShortcuts: true,
          onRenderedRegionGeometryChange: onGeometryChange,
        }),
      );
      expect(onGeometryChange).not.toHaveBeenCalled();
    });
  });

  describe('applyDockSnap', () => {
    test('collapsed closes the dock', async () => {
      const useDockShellChrome = await freshUseDockShellChrome();
      const { result } = renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      act(() => result.current.applyDockSnap('collapsed'));
      expect(setDockState).toHaveBeenCalledWith(false, false);
      expect(result.current.dockSnap).toBe('collapsed');
    });

    test('full opens and maximizes the dock', async () => {
      const useDockShellChrome = await freshUseDockShellChrome();
      const { result } = renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      act(() => result.current.applyDockSnap('full'));
      expect(setDockState).toHaveBeenCalledWith(true, true);
      expect(result.current.dockSnap).toBe('full');
    });
  });

  // archive#4525 Phase 2: the dock's project binding is owned here, not by
  // the occupant that reads it — these pin persistence, the deletion-cleanup
  // contract, and (critically) that nothing here clears the binding on its
  // own initiative.
  describe('activeProjectSlug', () => {
    test('defaults to null and persists an explicit bind via the device setting', async () => {
      projectsForDockShellChrome = [{ slug: 'alpha' }];
      const useDockShellChrome = await freshUseDockShellChrome();
      const { result } = renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      expect(result.current.activeProjectSlug).toBeNull();

      act(() => result.current.setActiveProjectSlug('alpha'));
      expect(result.current.activeProjectSlug).toBe('alpha');
      const envelope = JSON.parse(
        localStorage.getItem('station-device-settings-v1') || '{}',
      );
      expect(envelope.values.chatDockProjectSlug).toBe('alpha');
    });

    test('a second mount reads the persisted binding back (survives remount, station#4525)', async () => {
      projectsForDockShellChrome = [{ slug: 'alpha' }];
      const first = await freshUseDockShellChrome();
      const mounted = renderHook(() =>
        first({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      act(() => mounted.result.current.setActiveProjectSlug('alpha'));
      mounted.unmount();

      const second = await freshUseDockShellChrome();
      const remounted = renderHook(() =>
        second({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      expect(remounted.result.current.activeProjectSlug).toBe('alpha');
    });

    test('clears the binding once the bound project is confirmed gone (deletion cleanup)', async () => {
      projectsForDockShellChrome = [{ slug: 'alpha' }];
      const useDockShellChrome = await freshUseDockShellChrome();
      const { result, rerender } = renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      act(() => result.current.setActiveProjectSlug('alpha'));
      expect(result.current.activeProjectSlug).toBe('alpha');

      // The project list no longer names 'alpha' — deleted, via a
      // SUCCESSFUL, confirmed load (the marker distinct from the error
      // shape below: `isConfirmedLoaded: true` is the positive evidence
      // this cleanup requires, not merely `[]`).
      projectsForDockShellChrome = [];
      projectsConfirmedLoadedForDockShellChrome = true;
      rerender();
      expect(result.current.activeProjectSlug).toBeNull();
    });

    test('does NOT clear the binding while the projects query is still PENDING (absence-as-success guard)', async () => {
      projectsForDockShellChrome = [{ slug: 'alpha' }];
      const useDockShellChrome = await freshUseDockShellChrome();
      const { result, rerender } = renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      act(() => result.current.setActiveProjectSlug('alpha'));

      // A cold boot: the query resets to its pending shape (`[]`,
      // `isLoading: true`, not yet confirmed) before it has answered. An
      // empty array here must NOT read as "the project is gone" — only a
      // CONFIRMED, genuinely-empty/mismatched list may clear the binding.
      projectsForDockShellChrome = [];
      projectsLoadingForDockShellChrome = true;
      projectsConfirmedLoadedForDockShellChrome = false;
      rerender();
      expect(result.current.activeProjectSlug).toBe('alpha');
    });

    // archive#4525: the pre-fix guard was `!isLoading`, which
    // is ALSO true the moment the query settles into an ERROR —
    // `ProjectsContext` folds the error shape's missing `data` to the same
    // `[]` a confirmed-empty list produces, so `!isLoading && []` could not
    // tell "deleted" from "the server errored" apart. This is the
    // DISCRIMINATING case the fix exists for: `isLoading: false` (the query
    // has settled) but `isConfirmedLoaded: false` (it settled into an
    // error, not a success) must still leave the binding untouched — a
    // pre-fix guard reading only `!isLoading` would wipe it here.
    test('does NOT clear the binding while the projects query has ERRORED (station#4525 review HIGH-1)', async () => {
      projectsForDockShellChrome = [{ slug: 'alpha' }];
      const useDockShellChrome = await freshUseDockShellChrome();
      const { result, rerender } = renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      act(() => result.current.setActiveProjectSlug('alpha'));

      // The error shape: settled (`isLoading: false`) but never confirmed
      // (`isConfirmedLoaded: false`), `projects` folded to `[]` exactly as
      // it is for a genuine deletion.
      projectsForDockShellChrome = [];
      projectsLoadingForDockShellChrome = false;
      projectsConfirmedLoadedForDockShellChrome = false;
      rerender();
      expect(
        result.current.activeProjectSlug,
        'an errored query must never be read as confirmed deletion',
      ).toBe('alpha');
    });

    test('a full-screen placement (publishesDockSlotClearance: false) never runs the deletion cleanup itself', async () => {
      projectsForDockShellChrome = [{ slug: 'alpha' }];
      const useDockShellChrome = await freshUseDockShellChrome();
      const { result, rerender } = renderHook(() =>
        useDockShellChrome({
          publishesDockSlotClearance: false,
          registersDockShortcuts: true,
        }),
      );
      act(() => result.current.setActiveProjectSlug('alpha'));

      projectsForDockShellChrome = [];
      rerender();
      // This local, non-ambient instance still reads the shared persisted
      // value live; it just isn't the one reconciling it against deletion
      // (archive#4460's single-writer pattern, extended to this cleanup).
      expect(result.current.activeProjectSlug).toBe('alpha');
    });

    test('an Activity region shell never runs the Chat project-binding cleanup', async () => {
      projectsForDockShellChrome = [{ slug: 'alpha' }];
      const { useDockShellChrome, wrapper } =
        await freshDockShellChromeInRegionModel();
      const { useRegionModel } = await import('../contexts/RegionModelContext');
      const { result, rerender } = renderHook(
        () => ({
          chrome: useDockShellChrome({
            publishesDockSlotClearance: true,
            registersDockShortcuts: false,
            regionId: 'right',
          }),
          model: useRegionModel(),
        }),
        { wrapper },
      );
      act(() => result.current.model.placeSurface('activity', 'right'));
      act(() => result.current.chrome.setActiveProjectSlug('alpha'));

      projectsForDockShellChrome = [];
      projectsConfirmedLoadedForDockShellChrome = true;
      rerender();

      expect(result.current.chrome.activeProjectSlug).toBe('alpha');
    });

    test('nothing in this hook clears the binding merely because it mounted (no reset-on-mount)', async () => {
      projectsForDockShellChrome = [{ slug: 'alpha' }];
      const first = await freshUseDockShellChrome();
      const mounted = renderHook(() =>
        first({
          publishesDockSlotClearance: true,
          registersDockShortcuts: true,
        }),
      );
      act(() => mounted.result.current.setActiveProjectSlug('alpha'));
      mounted.unmount();

      // Simulate an occupant switch away and back: a fresh mount of the SAME
      // persistent hook instance (this is what `DockShell` actually does —
      // it never unmounts on an occupant switch, only the Chat occupant
      // does), several times over.
      for (let i = 0; i < 3; i += 1) {
        const remount = await freshUseDockShellChrome();
        const { result, unmount } = renderHook(() =>
          remount({
            publishesDockSlotClearance: true,
            registersDockShortcuts: true,
          }),
        );
        expect(result.current.activeProjectSlug).toBe('alpha');
        unmount();
      }
    });
  });
});
