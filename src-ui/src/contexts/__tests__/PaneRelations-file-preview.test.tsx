/** @vitest-environment jsdom */

/**
 * Related file previews through the real region model and relations provider
 * (docs/design/pane-relationships.md): one reusable preview per exact opener
 * selection, Keep, exact-target focus including the Station, protection of
 * unsaved work, source hide/restore, and every refusal — no Station, no Web
 * Locks, another tab writing, a newer record, the bound, Cancel — leaving the
 * record, the arrangement and every occurrence's storage exactly as they were.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ShellSurfaceSuspension } from '../../app-shell/ShellSurfaceSuspension';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { readPaneFence, writePaneFence } from '../../regions/pane-fence';
import {
  openerSelectionKey,
  PANE_RELATIONS_LIMIT,
  PANE_RELATIONS_STORAGE_KEY,
  type PaneOpener,
  type PaneRelation,
  parsePaneRelations,
  serializePaneRelations,
} from '../../regions/pane-relations';
import type { RegionArrangement } from '../../regions/region-model';
import {
  readFilePreviewPaneState,
  writeFilePreviewPaneState,
} from '../../workspace-panes/filePreviewPaneStateStorage';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import {
  type RelatedOpenOutcome,
  useOpenRelatedFilePreview,
} from '../openRelatedFilePreview';
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
import {
  type Authority,
  AuthorityHarness,
  authoritySwitch,
  type FakeLocks,
  installFakeLocks,
  removeLocks,
  settledStorageSnapshot,
} from './paneRelationsHarness';

const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };
const SECURITY: PaneOpener = {
  occurrenceId: 'chat',
  label: 'Security review',
  source: {
    kind: 'conversation',
    conversationId: 'conversation-security',
    threadId: 'thread-security',
    projectSlug: 'station',
  },
};
const DOCS_SELECTION = 'thread:thread-docs';

const probe = {
  model: null as ReturnType<typeof useRegionModel> | null,
  shellRegions: null as RegionArrangement | null,
  relations: null as PaneRelationsValue | null,
  open: null as ReturnType<typeof useOpenRelatedFilePreview>,
  setSelection: null as ((selection: string | null) => void) | null,
};

function Probe() {
  const model = useRegionModel();
  const relations = usePaneRelations();
  const open = useOpenRelatedFilePreview(SECURITY);
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

/** Chat as an opener, publishing the conversation it shows. */
function ChatSelection() {
  const [selection, setSelection] = useState<string | null>(null);
  probe.setSelection = setSelection;
  usePublishOpenerSelection('chat', selection);
  return null;
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

async function open(path: string): Promise<RelatedOpenOutcome> {
  let outcome!: RelatedOpenOutcome;
  await act(async () => {
    const openPreview = probe.open;
    if (!openPreview) throw new Error('no opener');
    outcome = await openPreview({ ...PROJECT, path });
  });
  return outcome;
}

function storedRecord() {
  return parsePaneRelations(localStorage.getItem(PANE_RELATIONS_STORAGE_KEY))
    .record;
}

function relationOf(id: string): PaneRelation | undefined {
  return storedRecord().entries.find((entry) => entry.instanceId === id);
}

let locks: FakeLocks;

beforeEach(() => {
  probe.model = null;
  probe.shellRegions = null;
  probe.relations = null;
  probe.open = null;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  locks = installFakeLocks();
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
  removeLocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('related file previews', () => {
  test('a second file from the same conversation reuses the one preview tab in place', async () => {
    await mount();
    act(() => probe.model?.placeSurface('activity', 'right'));
    expect(await open('src/a.ts')).toMatchObject({
      ok: true,
      disposition: 'opened',
    });
    const firstId = previewsInRight()[0] as string;
    expect(right().panes).toEqual(['activity', firstId]);
    expect(readPaneFence(localStorage, firstId)).toEqual({
      status: 'fenced',
      stationId: 'station-a',
    });

    expect(await open('src/b.ts')).toMatchObject({
      ok: true,
      disposition: 'replaced',
    });
    const [secondId] = previewsInRight();
    expect(secondId).not.toBe(firstId);
    expect(right().panes).toEqual(['activity', secondId]);
    expect(right().occupant).toBe(secondId);
    // The replaced occurrence is gone: its state, its fence, its relation.
    expect(readFilePreviewPaneState(localStorage, firstId)).toBe(null);
    expect(readPaneFence(localStorage, firstId)).toEqual({ status: 'none' });
    expect(relationOf(firstId)).toBe(undefined);
    expect(relationOf(secondId as string)).toMatchObject({
      kept: false,
      stationId: 'station-a',
      opener: SECURITY,
    });
  });

  test('Keep protects the preview; reopening a kept file focuses it without overwriting', async () => {
    await mount();
    await open('src/a.ts');
    const [keptId] = previewsInRight();
    await act(async () => {
      await probe.relations?.keep(keptId as string);
    });
    expect(relationOf(keptId as string)?.kept).toBe(true);
    expect(await open('src/b.ts')).toMatchObject({ disposition: 'opened' });
    const [, previewId] = previewsInRight();
    expect(previewsInRight()).toEqual([keptId, previewId]);

    expect(await open('src/a.ts')).toMatchObject({
      ok: true,
      disposition: 'focused',
      surfaceId: keptId,
      existing: true,
    });
    expect(previewsInRight()).toEqual([keptId, previewId]);
    expect(right().occupant).toBe(keptId);
    expect(
      readFilePreviewPaneState(localStorage, previewId as string)?.path,
    ).toBe('src/b.ts');
  });

  test('the exact target includes the Station', async () => {
    await mount({ station: 'station-a' });
    await open('src/a.ts');
    const [stationAId] = previewsInRight();
    await act(async () => {
      await probe.relations?.keep(stationAId as string);
    });

    act(() => authoritySwitch.set?.({ station: 'station-b' }));
    await waitFor(() => expect(probe.relations?.stationId).toBe('station-b'));
    expect(await open('src/a.ts')).toMatchObject({
      ok: true,
      disposition: 'opened',
    });
    const [, stationBId] = previewsInRight();
    expect(stationBId).toBeDefined();
    expect(readPaneFence(localStorage, stationAId as string)).toEqual({
      status: 'fenced',
      stationId: 'station-a',
    });
    expect(readPaneFence(localStorage, stationBId as string)).toEqual({
      status: 'fenced',
      stationId: 'station-b',
    });
  });

  test('changing conversation hides its transient preview and returning restores it', async () => {
    await mount();
    act(() => probe.setSelection?.(openerSelectionKey(SECURITY)));
    await open('src/a.ts');
    const [previewId] = previewsInRight();
    await waitFor(() =>
      expect(probe.shellRegions?.right.panes).toEqual([previewId]),
    );

    act(() => probe.setSelection?.(DOCS_SELECTION));
    await waitFor(() => expect(probe.shellRegions?.right.panes).toEqual([]));
    expect(probe.shellRegions?.right.visible).toBe(false);
    expect(right().panes).toEqual([previewId]);

    act(() => probe.setSelection?.(openerSelectionKey(SECURITY)));
    await waitFor(() =>
      expect(probe.shellRegions?.right).toMatchObject({
        panes: [previewId],
        occupant: previewId,
        visible: true,
      }),
    );
  });

  test('an open for a conversation the opener no longer shows is superseded and changes nothing', async () => {
    await mount();
    act(() => probe.setSelection?.(DOCS_SELECTION));
    const before = await settledStorageSnapshot();
    expect(await open('src/a.ts')).toEqual({ ok: false, reason: 'superseded' });
    expect(await settledStorageSnapshot()).toEqual(before);
    expect(previewsInRight()).toEqual([]);
  });

  test('beginning an edit keeps the preview; the next file opens beside it', async () => {
    await mount();
    await open('src/a.ts');
    const [editedId] = previewsInRight();
    let unregister = () => {};
    await act(async () => {
      unregister = navigationStore.registerNavigationGuard(
        Symbol('edited preview'),
        (continueNavigation) => continueNavigation(),
        editedId,
      );
    });
    await waitFor(() =>
      expect(relationOf(editedId as string)?.kept).toBe(true),
    );
    try {
      expect(await open('src/b.ts')).toMatchObject({ disposition: 'opened' });
      const [, nextId] = previewsInRight();
      expect(previewsInRight()).toEqual([editedId, nextId]);
      expect(
        readFilePreviewPaneState(localStorage, editedId as string)?.path,
      ).toBe('src/a.ts');
    } finally {
      unregister();
    }
  });

  test('Cancel on the guard of the pane an open would cover changes nothing, focus included', async () => {
    await mount();
    await open('src/a.ts');
    const [coveredId] = previewsInRight();
    await act(async () => {
      await probe.relations?.keep(coveredId as string);
    });
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('dirty covered pane'),
      (_continue, cancel) => cancel?.(),
      coveredId,
    );
    const focus = document.createElement('button');
    document.body.append(focus);
    focus.focus();
    const arrangement = structuredClone(probe.model?.regions);
    const before = await settledStorageSnapshot();
    try {
      expect(await open('src/b.ts')).toEqual({
        ok: false,
        reason: 'guard-cancelled',
      });
      expect(await settledStorageSnapshot()).toEqual(before);
      expect(probe.model?.regions).toEqual(arrangement);
      expect(document.activeElement).toBe(focus);
    } finally {
      unregister();
      focus.remove();
    }
  });

  test('without a verified Station the opener keeps its pre-relationship behaviour', async () => {
    await mount('unverified');
    expect(probe.relations?.stationId).toBe(null);
    const first = await open('src/a.ts');
    expect(first).toMatchObject({ ok: true });
    expect(first).not.toHaveProperty('disposition');
    await open('src/b.ts');
    expect(previewsInRight()).toHaveLength(2);
    await open('src/a.ts');
    expect(previewsInRight()).toHaveLength(2);
    for (const id of previewsInRight())
      expect(readPaneFence(localStorage, id)).toEqual({ status: 'none' });
    expect(localStorage.getItem(PANE_RELATIONS_STORAGE_KEY)).toBe(null);
  });
});

describe('refusals leave everything as it was', () => {
  async function refusedWith(reason: string, setup?: () => () => void) {
    await mount();
    const restore = setup?.() ?? (() => {});
    const arrangement = structuredClone(probe.model?.regions);
    const before = await settledStorageSnapshot();
    try {
      expect(await open('src/a.ts')).toEqual({ ok: false, reason });
      expect(await settledStorageSnapshot()).toEqual(before);
      expect(probe.model?.regions).toEqual(arrangement);
    } finally {
      restore();
    }
  }

  test('no Web Locks', async () => {
    await refusedWith('lock-unavailable', () => {
      removeLocks();
      return () => {};
    });
  });

  test('another tab holds the lock', async () => {
    await refusedWith('contended', () => locks.holdExternally());
  });

  test('a record a newer build wrote is neither applied nor overwritten', async () => {
    const newer = JSON.stringify({ version: 2, entries: [{ future: true }] });
    await refusedWith('unsupported-record', () => {
      localStorage.setItem(PANE_RELATIONS_STORAGE_KEY, newer);
      return () => {};
    });
    expect(localStorage.getItem(PANE_RELATIONS_STORAGE_KEY)).toBe(newer);
  });

  test('the bound: live entries of OTHER tabs are never evicted', async () => {
    await refusedWith('capacity', () => {
      // Occurrences another tab shows: each fenced, the previews with their
      // own state (at most the 24 the preview store holds), the rest of
      // another kind this path cannot see the state of. None is placed here.
      const entries: PaneRelation[] = [];
      for (let i = 0; i < PANE_RELATIONS_LIMIT; i += 1) {
        const hex = i.toString(16).padStart(32, '0');
        const preview = i < 24;
        const id = preview ? `file-preview:${hex}` : `plugin-pane:${hex}`;
        writePaneFence(localStorage, id, 'station-a');
        if (preview)
          writeFilePreviewPaneState(localStorage, id, {
            version: '1.0',
            projectSlug: 'station',
            path: `src/other-${i}.ts`,
            wrap: true,
          });
        entries.push({
          instanceId: id,
          stateKey: id,
          stationId: 'station-a',
          generation: 'builtin',
          opener: { ...SECURITY, occurrenceId: `other-${i}` },
          target: {
            kind: 'file',
            ...PROJECT,
            path: `src/other-${i}.ts`,
            thread: null,
          },
          kept: true,
          openedAt: i,
        });
      }
      localStorage.setItem(
        PANE_RELATIONS_STORAGE_KEY,
        serializePaneRelations({ version: 1, entries }),
      );
      return () => {};
    });
    expect(storedRecord().entries).toHaveLength(PANE_RELATIONS_LIMIT);
  });
});

/** A second relations owner, as another tab with its own (stale) copy. */
const second = { relations: null as PaneRelationsValue | null };
function SecondProbe() {
  const relations = usePaneRelations();
  useEffect(() => {
    second.relations = relations;
  }, [relations]);
  return null;
}

describe('two owners of the shared record', () => {
  test('a write from a stale copy keeps the other owner’s entry', async () => {
    render(
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <AuthorityHarness initial={{ station: 'station-a' }}>
            <RegionModelProvider>
              <PaneRelationsProvider>
                <Probe />
              </PaneRelationsProvider>
              <PaneRelationsProvider>
                <SecondProbe />
              </PaneRelationsProvider>
            </RegionModelProvider>
          </AuthorityHarness>
        </NavigationProvider>
      </KeyboardShortcutsProvider>,
    );
    await waitFor(() => expect(second.relations).not.toBeNull());
    // Both owners mounted before either wrote: each holds an empty copy, and
    // jsdom delivers no storage event to its own window.
    const entry = (id: string): PaneRelation => ({
      instanceId: id,
      stateKey: id,
      stationId: 'station-a',
      generation: 'builtin',
      opener: SECURITY,
      target: { kind: 'file', ...PROJECT, path: id, thread: null },
      kept: true,
      openedAt: 1,
    });
    for (const id of ['first', 'second'])
      writePaneFence(localStorage, id, 'station-a');
    await act(async () => {
      await probe.relations?.transact((tx) => {
        tx.write({
          version: 1,
          entries: [...tx.record.entries, entry('first')],
        });
        return { ok: true, value: undefined };
      });
    });
    await act(async () => {
      await second.relations?.transact((tx) => {
        tx.write({
          version: 1,
          entries: [...tx.record.entries, entry('second')],
        });
        return { ok: true, value: undefined };
      });
    });
    expect(storedRecord().entries.map((e) => e.instanceId)).toEqual([
      'first',
      'second',
    ]);
  });
});
