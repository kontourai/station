/** @vitest-environment jsdom */

/**
 * Related file previews through the real region model and relations provider
 * (docs/design/pane-relationships.md): one reusable preview per exact opener
 * selection, Keep, exact-target focus including the Station, protection of
 * unsaved work, source hide/restore, and the unchanged pre-relationship
 * behaviour while no Station is verified.
 */

import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ShellSurfaceSuspension } from '../../app-shell/ShellSurfaceSuspension';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  PANE_RELATIONS_STORAGE_KEY,
  type PaneOpener,
} from '../../regions/pane-relations';
import type { RegionArrangement } from '../../regions/region-model';
import { readFilePreviewPaneState } from '../../workspace-panes/filePreviewPaneStateStorage';
import { isWrongStationRelation } from '../../workspace-panes/RelatedPaneStrip';
import { AuthorityPersistenceContext } from '../AuthorityPersistenceContext';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import {
  PaneRelationsProvider,
  type PaneRelationsValue,
  usePaneRelations,
  usePublishOpenerSelection,
} from '../PaneRelationsContext';
import {
  RegionModelProvider,
  useRegionModel,
  useRegionModelOptional,
} from '../RegionModelContext';
import { useOpenFilePreviewInRegion } from '../useOpenInRegion';

const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };
const SECURITY: PaneOpener = {
  occurrenceId: 'chat',
  selection: 'thread:security-review',
  label: 'Security review',
};

function observation(environmentId: string): AuthorityObservation {
  return {
    schemaVersion: 'station.authority-observation/v1',
    environmentId,
    principal: { kind: 'human', id: 'operator' },
    grant: { kind: 'operator' },
  };
}

type Authority = 'unavailable' | { station: string };

const probe = {
  model: null as ReturnType<typeof useRegionModel> | null,
  shellRegions: null as RegionArrangement | null,
  relations: null as PaneRelationsValue | null,
  open: null as ReturnType<typeof useOpenFilePreviewInRegion>,
  setAuthority: null as ((authority: Authority) => void) | null,
  setSelection: null as ((selection: string | null) => void) | null,
};

function Probe() {
  const model = useRegionModel();
  const relations = usePaneRelations();
  const open = useOpenFilePreviewInRegion(SECURITY);
  useEffect(() => {
    probe.model = model;
    probe.relations = relations;
    probe.open = open;
  }, [model, relations, open]);
  return null;
}

/** What the region shells read: the arrangement through their suspension. */
function ShellReader() {
  const model = useRegionModelOptional();
  useEffect(() => {
    probe.shellRegions = model?.regions ?? null;
  }, [model]);
  return null;
}

/** Chat as an opener, publishing the session it shows. */
function ChatSelection() {
  const [selection, setSelection] = useState<string | null>(null);
  probe.setSelection = setSelection;
  usePublishOpenerSelection('chat', selection);
  return null;
}

function AuthorityHarness({
  initial,
  children,
}: {
  initial: Authority;
  children: ReactNode;
}) {
  const [authority, setAuthority] = useState<Authority>(initial);
  probe.setAuthority = setAuthority;
  const value =
    authority === 'unavailable'
      ? { status: 'unavailable' as const, namespace: null, observation: null }
      : {
          status: 'verified' as const,
          namespace: `ns:${authority.station}`,
          observation: observation(authority.station),
        };
  return (
    <AuthorityPersistenceContext.Provider value={value}>
      {children}
    </AuthorityPersistenceContext.Provider>
  );
}

async function mount(initial: Authority = { station: 'station-a' }) {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <AuthorityHarness initial={initial}>
          <RegionModelProvider>
            <PaneRelationsProvider>
              <Probe />
              <ChatSelection />
              <ShellSurfaceSuspension>
                <ShellReader />
              </ShellSurfaceSuspension>
            </PaneRelationsProvider>
          </RegionModelProvider>
        </AuthorityHarness>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(probe.open).not.toBeNull());
}

function right() {
  if (!probe.model) throw new Error('probe never rendered');
  return probe.model.regions.right;
}

function previewsInRight(): string[] {
  return right().panes.filter((id) => id.startsWith('file-preview:'));
}

function open(path: string) {
  let outcome!: ReturnType<NonNullable<typeof probe.open>>;
  act(() => {
    const openPreview = probe.open;
    if (!openPreview) throw new Error('no opener');
    outcome = openPreview({ ...PROJECT, path });
  });
  return outcome as typeof outcome & { disposition?: string };
}

beforeEach(() => {
  probe.model = null;
  probe.shellRegions = null;
  probe.relations = null;
  probe.open = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
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

describe('related file previews', () => {
  test('a second file from the same session reuses the one preview tab in place', async () => {
    await mount();
    act(() => probe.model?.placeSurface('activity', 'right'));
    const first = open('src/a.ts');
    expect(first).toMatchObject({ ok: true, disposition: 'opened' });
    const firstId = previewsInRight()[0] as string;
    expect(right().panes).toEqual(['activity', firstId]);

    const second = open('src/b.ts');
    expect(second).toMatchObject({ ok: true, disposition: 'replaced' });
    const [secondId] = previewsInRight();
    expect(secondId).not.toBe(firstId);
    // The same tab slot, selected; the replaced preview's state is gone.
    expect(right().panes).toEqual(['activity', secondId]);
    expect(right().occupant).toBe(secondId);
    expect(readFilePreviewPaneState(localStorage, firstId)).toBe(null);
    expect(
      readFilePreviewPaneState(localStorage, secondId as string)?.path,
    ).toBe('src/b.ts');
    expect(probe.relations?.relationOf(secondId as string)).toMatchObject({
      kept: false,
      stationId: 'station-a',
      opener: SECURITY,
    });
    expect(probe.relations?.relationOf(firstId)).toBe(undefined);
  });

  test('a destination opens in Related even when Tools is free', async () => {
    await mount();
    act(() => {
      probe.model?.placeSurface('activity', 'right');
      probe.model?.removePane('bottom', 'chat');
    });
    expect(probe.model?.regions.bottom.panes).toEqual([]);
    open('src/a.ts');
    expect(previewsInRight()).toHaveLength(1);
    expect(probe.model?.regions.bottom.panes).toEqual([]);
    expect(probe.model?.regions.left.panes).toEqual([]);
  });

  test('Keep protects the preview; reopening a kept file focuses it without overwriting', async () => {
    await mount();
    open('src/a.ts');
    const [keptId] = previewsInRight();
    act(() => probe.relations?.keep(keptId as string));
    expect(open('src/b.ts')).toMatchObject({ disposition: 'opened' });
    const [, previewId] = previewsInRight();
    expect(previewsInRight()).toEqual([keptId, previewId]);

    const again = open('src/a.ts');
    expect(again).toMatchObject({
      ok: true,
      disposition: 'focused',
      surfaceId: keptId,
      existing: true,
    });
    expect(previewsInRight()).toEqual([keptId, previewId]);
    expect(right().occupant).toBe(keptId);
    // The transient preview still shows what it showed.
    expect(
      readFilePreviewPaneState(localStorage, previewId as string)?.path,
    ).toBe('src/b.ts');
  });

  test('the exact target includes the Station', async () => {
    await mount({ station: 'station-a' });
    open('src/a.ts');
    const [stationAId] = previewsInRight();
    act(() => probe.relations?.keep(stationAId as string));

    act(() => probe.setAuthority?.({ station: 'station-b' }));
    await waitFor(() => expect(probe.relations?.stationId).toBe('station-b'));
    const reopened = open('src/a.ts');
    expect(reopened).toMatchObject({ ok: true, disposition: 'opened' });
    const [, stationBId] = previewsInRight();
    expect(stationBId).toBeDefined();
    expect(stationBId).not.toBe(stationAId);
    // Station A's pane is recognised as another Station's, never read here.
    expect(
      isWrongStationRelation(
        probe.relations?.relationOf(stationAId as string),
        'station-b',
      ),
    ).toBe(true);
    expect(
      isWrongStationRelation(
        probe.relations?.relationOf(stationBId as string),
        'station-b',
      ),
    ).toBe(false);
  });

  test('changing session hides its transient preview and returning restores it', async () => {
    await mount();
    act(() => probe.setSelection?.(SECURITY.selection));
    open('src/a.ts');
    const [previewId] = previewsInRight();
    await waitFor(() =>
      expect(probe.shellRegions?.right.panes).toEqual([previewId]),
    );

    act(() => probe.setSelection?.('thread:documentation-review'));
    // Hidden from the shells (the region empties and hides), kept in the
    // record: nothing was closed.
    await waitFor(() => expect(probe.shellRegions?.right.panes).toEqual([]));
    expect(probe.shellRegions?.right.visible).toBe(false);
    expect(right().panes).toEqual([previewId]);

    act(() => probe.setSelection?.(SECURITY.selection));
    await waitFor(() =>
      expect(probe.shellRegions?.right).toMatchObject({
        panes: [previewId],
        occupant: previewId,
        visible: true,
      }),
    );
  });

  test('a kept preview stays on screen when the session changes', async () => {
    await mount();
    act(() => probe.setSelection?.(SECURITY.selection));
    open('src/a.ts');
    const [keptId] = previewsInRight();
    act(() => probe.relations?.keep(keptId as string));
    act(() => probe.setSelection?.('thread:documentation-review'));
    await waitFor(() =>
      expect(probe.shellRegions?.right.panes).toEqual([keptId]),
    );
  });

  test('a preview with unsaved work is protected instead of replaced', async () => {
    await mount();
    open('src/a.ts');
    const [editedId] = previewsInRight();
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('edited preview'),
      (continueNavigation) => continueNavigation(),
      editedId,
    );
    try {
      expect(open('src/b.ts')).toMatchObject({ disposition: 'opened' });
      const [, nextId] = previewsInRight();
      expect(previewsInRight()).toEqual([editedId, nextId]);
      expect(probe.relations?.relationOf(editedId as string)?.kept).toBe(true);
      expect(
        readFilePreviewPaneState(localStorage, editedId as string)?.path,
      ).toBe('src/a.ts');
    } finally {
      unregister();
    }
  });

  test('without a verified Station the opener keeps its pre-relationship behaviour', async () => {
    await mount('unavailable');
    expect(probe.relations?.stationId).toBe(null);
    const first = open('src/a.ts');
    expect(first).toMatchObject({ ok: true });
    expect(first).not.toHaveProperty('disposition');
    open('src/b.ts');
    expect(previewsInRight()).toHaveLength(2);
    // The path dedupe it always had: the same file is revealed, not doubled.
    open('src/a.ts');
    expect(previewsInRight()).toHaveLength(2);
    expect(localStorage.getItem(PANE_RELATIONS_STORAGE_KEY)).toBe(null);
  });

  test('a record a newer build wrote is neither applied nor overwritten', async () => {
    const newer = JSON.stringify({ version: 2, entries: [{ future: true }] });
    localStorage.setItem(PANE_RELATIONS_STORAGE_KEY, newer);
    await mount();
    open('src/a.ts');
    open('src/b.ts');
    expect(localStorage.getItem(PANE_RELATIONS_STORAGE_KEY)).toBe(newer);
    // Nothing recorded, so nothing is reused either: each open is its own.
    expect(previewsInRight()).toHaveLength(2);
  });
});
