/** @vitest-environment jsdom */

/**
 * #2049: the two instance-keyed openers — `openPullRequestInRegion` and
 * `openFilePreviewInRegion` — through the real provider. What they own beyond
 * `openInRegion` is what this proves: the Project binding a refusal reports,
 * a pull request's identity being its id (so a second open is a reveal), and
 * a file preview's persisted state being written before the placement and
 * removed again when the model refuses.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX,
  readFilePreviewPaneState,
} from '../../workspace-panes/filePreviewPaneStateStorage';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';
import { useOpenPaneInRegion } from '../useOpenInRegion';

const PR = {
  host: 'github.com',
  owner: 'kontourai',
  repository: 'station',
  ref: '2049',
};
const PR_ID = 'pr:github.com/kontourai/station#2049';
const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };

let model: ReturnType<typeof useRegionModel> | null = null;
let panes: ReturnType<typeof useOpenPaneInRegion> | null = null;

function Probe() {
  const value = useRegionModel();
  const openers = useOpenPaneInRegion();
  useEffect(() => {
    model = value;
    panes = openers;
  }, [value, openers]);
  return null;
}

async function mount(innerWidth = 1024) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: innerWidth,
  });
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
  await waitFor(() => expect(panes).not.toBeNull());
}

function current() {
  if (!model || !panes) throw new Error('probe never rendered');
  return { model, panes };
}

/** The stored state of one held preview, read the way the pane reads it. */
function heldState(id: string) {
  const state = readFilePreviewPaneState(localStorage, id);
  if (!state) throw new Error(`no stored state for ${id}`);
  return state;
}

function previewStateKeys(): string[] {
  return Object.keys(localStorage).filter((key) =>
    key.startsWith(`${FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX}:`),
  );
}

beforeEach(() => {
  model = null;
  panes = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('opening an instance-keyed pane in a region (#2049)', () => {
  test('a pull request opens as a tab and a second open reveals the same one', async () => {
    await mount();
    const { panes: openers } = current();
    let outcome!: ReturnType<typeof openers.openPullRequest>;
    act(() => {
      outcome = openers.openPullRequest(PR, PROJECT.projectId, {
        region: 'right',
      });
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'right',
      surfaceId: PR_ID,
      existing: false,
    });
    expect(current().model.regions.right.panes).toEqual([PR_ID]);
    expect(current().model.regions.right.occupant).toBe(PR_ID);
    expect(current().model.regions.right.visible).toBe(true);

    act(() => {
      outcome = current().panes.openPullRequest(
        // The same pull request spelled differently: one pane, revealed.
        { ...PR, host: 'GitHub.com', owner: 'Kontourai' },
        PROJECT.projectId,
      );
    });
    expect(outcome).toEqual({
      ok: true,
      region: 'right',
      surfaceId: PR_ID,
      existing: true,
    });
    expect(current().model.regions.right.panes).toEqual([PR_ID]);
  });

  test('without a project nothing is placed and the refusal says which', async () => {
    await mount();
    const before = current().model.regions;
    let pr: unknown;
    let preview: unknown;
    act(() => {
      pr = current().panes.openPullRequest(PR, null);
      preview = current().panes.openFilePreview({
        projectId: null,
        projectSlug: null,
        path: 'src/app.ts',
      });
    });
    expect(pr).toEqual({ ok: false, reason: 'unsupplied' });
    expect(preview).toEqual({ ok: false, reason: 'unsupplied' });
    // A refusal is not a state change: the arrangement keeps its identity and
    // nothing was written for a pane that never opened.
    expect(current().model.regions).toBe(before);
    expect(previewStateKeys()).toEqual([]);
  });

  test('a file preview writes its state, and a second click on the same file focuses that tab', async () => {
    await mount();
    let outcome: { ok: boolean } | undefined;
    act(() => {
      outcome = current().panes.openFilePreview(
        { ...PROJECT, path: 'src/app.ts' },
        { region: 'right' },
      );
    });
    expect(outcome).toMatchObject({ ok: true, region: 'right' });
    const placed = current().model.regions.right.panes;
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatch(/^file-preview:[0-9a-f]{32}$/);
    expect(previewStateKeys()).toHaveLength(1);

    act(() => {
      outcome = current().panes.openFilePreview({
        ...PROJECT,
        path: 'src/app.ts',
      });
    });
    // One nonce, one state record, one tab — the identity of a preview is the
    // file, even though its id is opaque.
    expect(outcome).toMatchObject({ existing: true, surfaceId: placed[0] });
    expect(current().model.regions.right.panes).toEqual(placed);
    expect(previewStateKeys()).toHaveLength(1);

    act(() => {
      current().panes.openFilePreview(
        { ...PROJECT, path: 'src/other.ts' },
        { region: 'right' },
      );
    });
    expect(current().model.regions.right.panes).toHaveLength(2);
    expect(previewStateKeys()).toHaveLength(2);
  });

  test('a refused open leaves no preview state behind', async () => {
    // Bottom-only: a side region is not available on this device, so the
    // model refuses — and the state written a moment earlier must not
    // survive a click that placed nothing.
    await mount(600);
    const before = current().model.regions;
    let outcome: unknown;
    act(() => {
      outcome = current().panes.openFilePreview(
        { ...PROJECT, path: 'src/app.ts' },
        { region: 'right' },
      );
    });
    expect(outcome).toEqual({ ok: false, reason: 'region-unavailable' });
    expect(current().model.regions).toBe(before);
    expect(previewStateKeys()).toEqual([]);
  });

  /**
   * Review M3. The dedupe matches on project and path only, so `#L400` on a
   * file already open at `#L5` reveals that tab — and before this it revealed
   * it still showing line 5, with nothing saying the requested line had been
   * dropped. Removing the range write reds the second assertion; writing it
   * unconditionally (clearing on a range-less open) reds the third; skipping
   * the rollback reds the fourth.
   */
  test('revealing a held preview carries a newly requested line range, keeps one with none requested, and rolls back a refusal', async () => {
    await mount();
    act(() => {
      current().panes.openFilePreview(
        { ...PROJECT, path: 'src/app.ts', lineRange: { start: 5, end: 5 } },
        { region: 'right' },
      );
    });
    const [held] = current().model.regions.right.panes as [string];
    expect(heldState(held).lineRange).toEqual({ start: 5, end: 5 });

    let outcome: { ok: boolean } | undefined;
    act(() => {
      outcome = current().panes.openFilePreview({
        ...PROJECT,
        path: 'src/app.ts',
        lineRange: { start: 400, end: 412 },
      });
    });
    expect(outcome).toMatchObject({ ok: true, existing: true });
    expect(current().model.regions.right.panes).toEqual([held]);
    expect(heldState(held).lineRange).toEqual({ start: 400, end: 412 });
    // `wrap` is the user's, not the opener's: a reveal must not reset it.
    expect(heldState(held).wrap).toBe(true);

    // An href with no line anchor names the file and says nothing about
    // lines, so it does not mean "forget the line".
    act(() => {
      current().panes.openFilePreview({ ...PROJECT, path: 'src/app.ts' });
    });
    expect(heldState(held).lineRange).toEqual({ start: 400, end: 412 });

    // A refused reveal leaves the stored range exactly as it was, the same
    // rule the mint path's rollback follows.
    act(() => {
      outcome = current().panes.openFilePreview(
        {
          ...PROJECT,
          path: 'src/app.ts',
          lineRange: { start: 900, end: 901 },
        },
        { placement: 'split' },
      );
    });
    expect(outcome).toEqual({ ok: false, reason: 'unsupported-placement' });
    expect(heldState(held).lineRange).toEqual({ start: 400, end: 412 });
  });
});
