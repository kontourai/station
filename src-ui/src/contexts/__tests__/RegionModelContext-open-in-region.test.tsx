/** @vitest-environment jsdom */

/**
 * #2048: `openInRegion` (`useOpenInRegion.ts`) over the provider's
 * `openSurfaceInRegion`. The rules are the pure model's (`revealSurface`,
 * `placeSurface`, `showSurfaceAlone`, `region-model.test.ts`); what this
 * file proves is the intent's resolution and its typed outcomes — where an
 * open lands without a region, with one, when the pane is already open, and
 * what each refusal leaves untouched — plus that `showSurface` still lands
 * where it did before it was reimplemented over the same core.
 */

import { WORKSPACE_ACTIVITY_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-activity-pane';
import { createWorkspaceCodingTerminalPaneInstance } from '@kontourai/station-contracts/workspace-coding-panels';
import { WORKSPACE_HOME_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-home-pane';
import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';
import { openInRegion, useOpenInRegion } from '../useOpenInRegion';

let model: ReturnType<typeof useRegionModel> | null = null;
let open: ReturnType<typeof useOpenInRegion> | null = null;

function Probe() {
  const value = useRegionModel();
  const command = useOpenInRegion();
  useEffect(() => {
    model = value;
    open = command;
  }, [value, command]);
  return null;
}

function Harness() {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

function setUrl(url: string) {
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function mount(innerWidth = 1024) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: innerWidth,
  });
  render(<Harness />);
  await waitFor(() => expect(model).not.toBeNull());
  await waitFor(() => expect(open).not.toBeNull());
}

function current() {
  if (!model || !open) throw new Error('probe never rendered');
  return { model, open };
}

beforeEach(() => {
  model = null;
  open = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  setUrl('/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setUrl('/');
});

describe('openInRegion resolves a region and places through the model (#2048)', () => {
  /**
   * Reverting the no-region branch to `placeSurface(defaultRegion)` still
   * passes here (right is free) — which is why the "right is taken" case
   * below exists; reverting `commit`'s `setLastShownRegion` fails the fold
   * assertion; adding a `navigate` to a dock open fails the pushState one.
   */
  test('with no region the surface lands by its own rule: its default region, selected and shown, with no history entry', async () => {
    await mount();
    const pushes = vi.spyOn(window.history, 'pushState');
    let outcome: unknown;
    act(() => {
      outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE);
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'right',
      surfaceId: 'activity',
      existing: false,
    });
    await waitFor(() =>
      expect(current().model.regions.right).toMatchObject({
        panes: ['activity'],
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(current().model.lastShownRegion).toBe('right');
    expect(pushes).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
  });

  test('when the default region is taken, an unplaced surface takes the first free dock region', async () => {
    await mount();
    act(() => current().model.placeSurface('chat', 'right'));
    await waitFor(() =>
      expect(current().model.regions.right.panes).toEqual(['chat']),
    );
    let outcome: unknown;
    act(() => {
      outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE);
    });
    // `firstFreeDockRegion`: bottom is the first free once right is taken.
    expect(outcome).toMatchObject({ ok: true, region: 'bottom' });
    expect(current().model.regions.bottom).toMatchObject({
      panes: ['activity'],
      occupant: 'activity',
      visible: true,
    });
  });

  /**
   * Reverting the explicit-region branch to the default rule fails the
   * `bottom` assertion (Activity would land in `right`).
   */
  test('an explicit region joins the panes there as the selected tab', async () => {
    await mount();
    let outcome: unknown;
    act(() => {
      outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, {
        region: 'bottom',
      });
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'bottom',
      surfaceId: 'activity',
      existing: false,
    });
    expect(current().model.regions.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
    });
    expect(current().model.regions.right.panes).toEqual([]);
  });

  /**
   * Reverting `focusExisting` (always placing) still passes the pane-set
   * assertions — `placeSurface` into the holding region selects — so the
   * outcome's `existing` and the no-region case (a placed surface must not
   * be moved to its default) are what discriminate.
   */
  test('an instance already open in some region is revealed there, not opened again', async () => {
    await mount();
    act(() =>
      current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, { region: 'bottom' }),
    );
    act(() => current().model.selectPane('bottom', 'chat'));
    act(() => current().model.setRegion('bottom', { visible: false }));
    await waitFor(() =>
      expect(current().model.regions.bottom).toMatchObject({
        occupant: 'chat',
        visible: false,
      }),
    );
    const pushes = vi.spyOn(window.history, 'pushState');

    let outcome: unknown;
    act(() => {
      outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE);
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'bottom',
      surfaceId: 'activity',
      existing: true,
    });
    expect(current().model.regions.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
    });
    // Not moved to its default region, not duplicated.
    expect(current().model.regions.right.panes).toEqual([]);
    expect(pushes).not.toHaveBeenCalled();

    // Naming the region it is in is the same reveal.
    act(() => {
      outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, {
        region: 'bottom',
      });
    });
    expect(outcome).toMatchObject({ ok: true, existing: true });
    expect(current().model.regions.bottom.panes).toEqual(['chat', 'activity']);
  });

  /**
   * The default does NOT keep a held pane where it is when a different
   * region is named (review L2): the reveal branch requires the target to be
   * absent or the region the pane already occupies, so an explicit target
   * moves it — which is what a region's "+" does to a singleton held
   * elsewhere. Reverting that (letting `focusExisting` reveal whatever the
   * target) fails the `existing: false`, the `right.panes` emptying and the
   * bottom pane-set assertions here, while the reveal test above keeps
   * passing.
   */
  test('the default focusExisting moves a held pane when a different region is named', async () => {
    await mount();
    act(() =>
      current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, { region: 'right' }),
    );
    expect(current().model.regions.right.panes).toEqual(['activity']);

    let outcome: unknown;
    act(() => {
      outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, {
        region: 'bottom',
      });
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'bottom',
      surfaceId: 'activity',
      existing: false,
    });
    expect(current().model.regions.right.panes).toEqual([]);
    expect(current().model.regions.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
    });
  });

  test('focusExisting: false with another region moves the pane there', async () => {
    await mount();
    act(() =>
      current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, { region: 'bottom' }),
    );
    let outcome: unknown;
    act(() => {
      outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, {
        region: 'right',
        focusExisting: false,
      });
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'right',
      surfaceId: 'activity',
      existing: false,
    });
    expect(current().model.regions.bottom.panes).toEqual(['chat']);
    expect(current().model.regions.right).toMatchObject({
      panes: ['activity'],
      occupant: 'activity',
      visible: true,
    });
  });

  test('a coding pane instance resolves to its surface; an impostor under the same descriptor does not', async () => {
    await mount();
    const terminal = createWorkspaceCodingTerminalPaneInstance('project-a');
    const impostor = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:builtin:coding:terminal',
      instanceId: 'workspace-coding-terminal-2',
      stateKey: 'workspace-coding-terminal-2',
      boundContext: {
        projectId: 'project-a',
        sourceId: 'builtin:workspace-coding-terminal',
      },
    });
    if (!terminal || !impostor) throw new Error('fixtures must parse');
    let outcome: unknown;
    act(() => {
      outcome = current().open(terminal);
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'right',
      surfaceId: 'coding:terminal',
      existing: false,
    });
    expect(current().model.regions.right.panes).toEqual(['coding:terminal']);
    expect(current().open(impostor)).toEqual({
      ok: false,
      reason: 'no-surface',
    });
  });
});

describe('openInRegion refusals change nothing (#2048)', () => {
  /**
   * Each refusal is asserted against the SAME `regions` reference: a refusal
   * that wrote the arrangement, even to an equal value, would hand the
   * provider a new object. Reverting any guard to a silent placement fails
   * the reference assertion for that case.
   */
  test('no surface, an undeclared region, an unavailable region and a split are each a typed refusal with no write and no navigation', async () => {
    await mount();
    const before = current().model.regions;
    const pushes = vi.spyOn(window.history, 'pushState');

    expect(current().open(WORKSPACE_HOME_PANE_INSTANCE)).toEqual({
      ok: false,
      reason: 'no-surface',
    });
    expect(current().model.openSurfaceInRegion('not-a-surface')).toEqual({
      ok: false,
      reason: 'no-surface',
    });
    // Chat declares the dock regions only.
    expect(
      current().model.openSurfaceInRegion('chat', { region: 'main' }),
    ).toEqual({ ok: false, reason: 'refused' });
    expect(
      current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, { placement: 'split' }),
    ).toEqual({ ok: false, reason: 'unsupported-placement' });

    expect(current().model.regions).toBe(before);
    expect(pushes).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
    // Refusals do not reach the intent outbox either.
    expect(current().model.surfaceIntents).toEqual({});
  });

  test('on a bottom-only device a side region is unavailable, and an open without a region folds the dock to the revealed region', async () => {
    await mount(600);
    const before = current().model.regions;
    expect(
      current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE, { region: 'right' }),
    ).toEqual({ ok: false, reason: 'region-unavailable' });
    expect(current().model.regions).toBe(before);

    let outcome: unknown;
    act(() => {
      outcome = current().open(WORKSPACE_ACTIVITY_PANE_INSTANCE);
    });
    // The surface's own rule places it (`right`, free); the fold then makes
    // that the only visible dock region, as `showSurface` did before #2048.
    expect(outcome).toMatchObject({ ok: true, region: 'right' });
    expect(current().model.regions.right).toMatchObject({
      panes: ['activity'],
      visible: true,
    });
    expect(current().model.regions.bottom.visible).toBe(false);
  });
});

describe('showSurface over openSurfaceInRegion (#2048)', () => {
  /**
   * The behaviour `RegionModelContext-deep-link.test.tsx`,
   * `RegionShellParity.test.tsx` and the toggle tests pin from the outside;
   * here the two verbs are compared on the same start state.
   */
  test('showSurface lands where openSurfaceInRegion lands and still carries an intent', async () => {
    await mount();
    act(() => current().model.showSurface('activity', { session: 's1' }));
    await waitFor(() =>
      expect(current().model.regions.right).toMatchObject({
        panes: ['activity'],
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(current().model.lastShownRegion).toBe('right');
    expect(current().model.surfaceIntents.activity).toMatchObject({
      session: 's1',
    });
    // An unregistered id is a no-op, as before: no write, no intent.
    const before = current().model.regions;
    act(() => current().model.showSurface('not-a-surface', { session: 's2' }));
    expect(current().model.regions).toBe(before);
    expect(current().model.surfaceIntents['not-a-surface']).toBeUndefined();
  });

  test('the pure openInRegion is the same fold the hook binds', async () => {
    await mount();
    const outcome = openInRegion(
      current().model,
      WORKSPACE_ACTIVITY_PANE_INSTANCE,
      { region: 'bottom' },
    );
    expect(outcome).toMatchObject({ ok: true, region: 'bottom' });
    await waitFor(() =>
      expect(current().model.regions.bottom.panes).toEqual([
        'chat',
        'activity',
      ]),
    );
  });
});
