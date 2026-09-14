/** @vitest-environment jsdom */

import { createDirectAnswerBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { WORKSPACE_ACTIVITY_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-activity-pane';
import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useBasisPaneLauncher } from '../BasisPaneLauncher';
import {
  AMBIENT_CHAT_DOCK_DOCUMENT_ID,
  adoptLegacyChatDockDocument,
  createAmbientChatDockPaneDocument,
  createRegionPaneHostDocument as deriveRegionPaneHostDocument,
  RegionPaneHost,
  reconcileRegionPaneHostDocument,
  regionPaneHostDocumentId,
} from '../RegionPaneHost';
import { workspacePaneHostStorageKey } from '../workspacePaneHostStorage';

/**
 * The derivation for a region whose panes need no context (Chat, Activity):
 * never null for those, so the tests below read it as a document. The null
 * case — a region of coding panes with no project — is asserted by name.
 */
function createRegionPaneHostDocument(
  ...args: Parameters<typeof deriveRegionPaneHostDocument>
) {
  const document = deriveRegionPaneHostDocument(...args);
  if (!document) throw new Error('a context-free region derives a document');
  return document;
}

vi.mock('../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    chatDockHeight: 320,
    chatDockWidth: 400,
  }),
  // `DockShell` (archive#4460) owns dock chrome, including the drag-end
  // device-settings commit `useChatDockState` used to own.
  useDeviceSettingsActions: () => ({ setDeviceSetting: () => {} }),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    dockMode: 'bottom',
    isDockOpen: true,
    isDockMaximized: false,
    pathname: '/',
    setDockState: () => {},
    setDockMode: () => {},
    collapseMaximizedDock: () => {},
  }),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => null,
}));

vi.mock('../BasisPaneFallbackContent', () => ({
  ConnectedBasisFallbackPane: () => <p>Basis fallback content</p>,
}));

// archive#4525: `DockShell` (via `useDockShellChrome`) reads `useProjects`
// for its project-binding deletion cleanup. Mocked here the same way every
// other unrelated context in this file is — this suite is about the Chat
// host's admission and persistence, not project binding (see
// `DockShellProjectBinding.test.tsx` for that).
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  // #2047: the region host resolves the dock's project through this read;
  // no project here, so the panes that need one derive none.
  useProject: () => ({ project: undefined, isLoading: false }),
}));

// `DockShell` (archive#4460) registers `dock.toggle`/`dock.maximize` via the
// real `useKeyboardShortcut`, which requires a `KeyboardShortcutsProvider`
// this host-level test doesn't mount. Neutralized the same way
// `ChatDockHeaderCollapse.test.tsx` neutralizes the header's own shortcut
// reads.
vi.mock('../../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
  useShortcutDisplay: () => '',
}));

/**
 * The literal key a user's dock state lives under. Spelled out, not derived
 * from the host's constants: the test's job is to notice the constants
 * moving. Renaming the document id or the scope segment resets every
 * device's dock on upgrade (#928 C2b keeps the key for exactly that reason).
 */
const AMBIENT_DOCK_STORAGE_KEY =
  'station:workspace-pane-host:v2:ambient:chat-dock';

/**
 * jsdom has no Web Locks, and the ambient host deliberately exposes no
 * lockManager prop — it IS the production wiring. Granting the lock through
 * `navigator.locks` exercises the same `browserWorkspacePaneHostLockManager`
 * path production takes.
 */
beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => void | Promise<void>,
      ) => callback({}),
    },
  });
  window.localStorage.removeItem(AMBIENT_DOCK_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(AMBIENT_DOCK_STORAGE_KEY);
  delete (globalThis.navigator as { locks?: unknown }).locks;
});

function renderAmbientHost() {
  return render(
    <RegionPaneHost
      renderChatPane={(instance) => (
        <p data-testid="ambient-chat-occupant">
          Chat pane {instance.instanceId}
        </p>
      )}
    />,
  );
}

function ProjectBasisLauncher() {
  const { openBasis, fallback } = useBasisPaneLauncher();
  const instance = createDirectAnswerBasisPaneInstance(
    'project-bound-basis',
    'session-a',
    'turn-a',
  )!;
  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          openBasis(
            instance,
            { kind: 'direct-answer', sessionId: 'session-a', turnId: 'turn-a' },
            event.currentTarget,
          )
        }
      >
        Open project Basis
      </button>
      {fallback}
    </>
  );
}

test('the ambient dock document names a projectless chat occupant in the docked region', () => {
  const document = createAmbientChatDockPaneDocument();

  expect(document).toMatchObject({
    id: 'chat-dock',
    scope: { kind: 'ambient' },
    instances: [
      {
        descriptorId: 'pane:builtin:chat',
        boundContext: { sourceId: 'builtin:workspace-chat' },
      },
    ],
  });
  expect(document.instances[0]?.boundContext?.projectId).toBeUndefined();
});

/**
 * #928 C2b: the docked-Home path was deleted, the document that outlived it
 * was not. Its key is a user's persisted dock state, so the document's own
 * identity (scope + id, the two inputs `workspacePaneHostStorageKey` folds)
 * must still resolve to the pre-C2b literal — a renamed id or scope would
 * silently reset every device's dock. Since #2045 that document is the
 * model-less mount's and the source a region adopts from
 * (`RegionPaneHost.regions.test.tsx`).
 */
test('the persisted dock document keeps its pre-C2b storage key', () => {
  const document = createAmbientChatDockPaneDocument();
  expect(AMBIENT_CHAT_DOCK_DOCUMENT_ID).toBe('chat-dock');
  expect(workspacePaneHostStorageKey(document.scope, document.id)).toBe(
    AMBIENT_DOCK_STORAGE_KEY,
  );
});

/**
 * #2045: a dock region's document is `ambient:<region>`, per REGION; only
 * the model-less mount (no region) keeps the legacy Chat document. A host
 * that derived the id from its occupant instead would fail the first two.
 */
test('a region host document is the region’s; the model-less mount keeps the legacy one', () => {
  expect(regionPaneHostDocumentId('bottom')).toBe('bottom');
  expect(
    workspacePaneHostStorageKey(
      { kind: 'ambient' },
      regionPaneHostDocumentId('right'),
    ),
  ).toBe('station:workspace-pane-host:v2:ambient:right');
  expect(regionPaneHostDocumentId(undefined)).toBe('chat-dock');
  const document = createRegionPaneHostDocument('left', ['activity']);
  expect(document).toMatchObject({
    id: 'left',
    scope: { kind: 'ambient' },
    instances: [{ descriptorId: 'pane:builtin:activity' }],
  });
  expect(() => createRegionPaneHostDocument('left', ['home'])).toThrow(
    /no built-in pane/,
  );
});

/**
 * #2047: a coding pane is the dock's PROJECT's. With a project the derived
 * instance binds it (and no layout); with none the pane has no instance —
 * left out of the document beside Chat, and no document at all alone — and
 * the selection falls back to a pane that exists. Reverting the factory to a
 * constant (`instance: ...`) cannot typecheck; reverting `flatMap` to `map`
 * with a null instance fails the `createWorkspacePaneHostBaselineDocument`
 * throw assertion below as a throw where an omission is expected.
 */
test('a coding surface derives the dock project’s instance, and none without a project', () => {
  const bound = createRegionPaneHostDocument(
    'right',
    ['chat', 'coding:terminal'],
    'coding:terminal',
    { projectId: 'project-uuid', projectSlug: 'alpha' },
  );
  expect(bound.instances.map((i) => i.descriptorId)).toEqual([
    'pane:builtin:chat',
    'pane:builtin:coding:terminal',
  ]);
  expect(bound.instances[1]?.boundContext).toEqual({
    projectId: 'project-uuid',
    sourceId: 'builtin:workspace-coding-terminal',
  });
  expect(bound.activeInstanceId).toBe('workspace-coding-terminal');

  const unbound = createRegionPaneHostDocument(
    'right',
    ['chat', 'coding:terminal'],
    'coding:terminal',
    { projectId: null, projectSlug: null },
  );
  expect(unbound.instances.map((i) => i.descriptorId)).toEqual([
    'pane:builtin:chat',
  ]);
  // The selected surface has no instance here: the document's active pane is
  // one it holds, not a dangling id the host would fail to mount.
  expect(unbound.activeInstanceId).toBe('workspace-chat');
  expect(
    deriveRegionPaneHostDocument('right', ['coding:terminal'], undefined, {
      projectId: null,
      projectSlug: null,
    }),
  ).toBeNull();
});

/**
 * #2046 2a. The derived document puts the selected pane first in nothing but
 * `active`: tab order is the arrangement's, selection is the arrangement's.
 * (The record's `pane-host` names no document — the region's id IS its
 * document id, `regionPaneHostDocumentId`, pinned above — so there is no
 * second name to keep equal; 2b dropped the field the 2a record carried.)
 */
test('the derived document activates the selected pane and keeps the arrangement’s tab order', () => {
  const document = createRegionPaneHostDocument(
    'right',
    ['chat', 'activity'],
    'activity',
  );
  expect(document.instances.map((i) => i.descriptorId)).toEqual([
    'pane:builtin:chat',
    'pane:builtin:activity',
  ]);
  expect(document.activeInstanceId).toBe('workspace-activity');
  expect(document.root).toMatchObject({
    type: 'tabs',
    instanceIds: ['workspace-chat', 'workspace-activity'],
    selectedInstanceId: 'workspace-activity',
  });
  // No selection named, or one with no pane: the first pane.
  expect(
    createRegionPaneHostDocument('right', ['chat', 'activity'])
      .activeInstanceId,
  ).toBe('workspace-chat');
  expect(
    createRegionPaneHostDocument('right', ['chat', 'activity'], 'home')
      .activeInstanceId,
  ).toBe('workspace-chat');
});

/**
 * The mount-time half of the pane set (#2046 2a): hydration can drop a
 * persisted pane the region no longer holds but can never ADD one, so a
 * region key written with Chat alone is rewritten to the derived two-pane
 * document before the host reads it. Deleting the write (or the call in
 * `RegionPaneHost`) makes the region show Chat alone after a reload that
 * added Activity between launches. A matching set is left untouched — its
 * tab group id survives — an absent key is not written (the host starts
 * from the derived document itself), and a persisted SUPERSET is not its
 * case either: hydration prunes that on its own.
 */
test('reconcileRegionPaneHostDocument rewrites a persisted document whose pane list differs and leaves a matching one alone', () => {
  const storage = new Map<string, string>();
  const adapter = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  const twoPanes = createRegionPaneHostDocument(
    'bottom',
    ['chat', 'activity'],
    'activity',
  );

  // Absent key: nothing written.
  expect(reconcileRegionPaneHostDocument(adapter, twoPanes)).toBe(false);
  expect(storage.has(BOTTOM_STORAGE_KEY)).toBe(false);

  // Chat alone persisted, two panes derived: rewritten.
  storage.set(BOTTOM_STORAGE_KEY, persistedChatDocument('bottom', 'my-group'));
  expect(reconcileRegionPaneHostDocument(adapter, twoPanes)).toBe(true);
  expect(JSON.parse(storage.get(BOTTOM_STORAGE_KEY)!)).toMatchObject({
    id: 'bottom',
    instances: [
      { descriptorId: 'pane:builtin:chat' },
      { descriptorId: 'pane:builtin:activity' },
    ],
    activeInstanceId: 'workspace-activity',
  });

  // Matching list, different selection: left alone, selection included —
  // the mounted host follows the arrangement's selection on its own.
  const chatSelected = createRegionPaneHostDocument(
    'bottom',
    ['chat', 'activity'],
    'chat',
  );
  expect(reconcileRegionPaneHostDocument(adapter, chatSelected)).toBe(false);
  expect(JSON.parse(storage.get(BOTTOM_STORAGE_KEY)!).activeInstanceId).toBe(
    'workspace-activity',
  );

  // Chat alone derived, two panes persisted: NOT this function's case.
  // Hydration against the one-pane catalog already restores that document
  // as Chat alone (`RegionPaneHost.regions.test.tsx`, "a stale region
  // document naming the previous occupant"), so the persisted pane list
  // hydrates equal to the derived one and nothing is written here; the host
  // persists the pruned document once it owns the lease.
  const chatAlone = createRegionPaneHostDocument('bottom', ['chat']);
  expect(reconcileRegionPaneHostDocument(adapter, chatAlone)).toBe(false);
  expect(
    JSON.parse(storage.get(BOTTOM_STORAGE_KEY)!).instances.map(
      (i: { descriptorId: string }) => i.descriptorId,
    ),
  ).toEqual(['pane:builtin:chat', 'pane:builtin:activity']);

  // Corrupt key: nothing written, no throw.
  storage.set(BOTTOM_STORAGE_KEY, '{not json');
  expect(reconcileRegionPaneHostDocument(adapter, twoPanes)).toBe(false);
  expect(storage.get(BOTTOM_STORAGE_KEY)).toBe('{not json');
});

/** A persisted Chat document under `id`, with a tab group id restoration keeps. */
function persistedChatDocument(id: string, rootId: string): string {
  return JSON.stringify({
    version: '1.1',
    id,
    scope: { kind: 'ambient' },
    instances: [
      {
        version: '1.0',
        descriptorId: 'pane:builtin:chat',
        instanceId: 'workspace-chat',
        stateKey: 'workspace-chat',
        boundContext: { sourceId: 'builtin:workspace-chat' },
      },
    ],
    activeInstanceId: 'workspace-chat',
    root: {
      type: 'tabs',
      id: rootId,
      instanceIds: ['workspace-chat'],
      selectedInstanceId: 'workspace-chat',
    },
  });
}

const BOTTOM_STORAGE_KEY = 'station:workspace-pane-host:v2:ambient:bottom';

/**
 * The pure half of adoption (#2045, design constraint 1). The tab group id
 * is the discriminator: the baseline's is `root`, so `legacy-group`
 * surviving under the region key proves the legacy document was read, not
 * a baseline written. Each `false` case is a distinct guard: absent legacy,
 * region key already present, corrupt legacy. Deleting either of the first
 * two guards makes its case write; deleting the corrupt-legacy guard (the
 * `try`/`catch`) makes its case THROW out of a render-time call instead of
 * returning false; the bare call in that case is the no-throw check (an
 * uncaught throw fails the test).
 */
test('adoptLegacyChatDockDocument re-identifies the legacy document as the region’s and leaves the legacy key', () => {
  const storage = new Map<string, string>();
  const adapter = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };

  expect(adoptLegacyChatDockDocument(adapter, 'bottom')).toBe(false);
  expect(storage.has(BOTTOM_STORAGE_KEY)).toBe(false);

  storage.set(
    AMBIENT_DOCK_STORAGE_KEY,
    persistedChatDocument('chat-dock', 'legacy-group'),
  );
  expect(adoptLegacyChatDockDocument(adapter, 'bottom')).toBe(true);
  const adopted = JSON.parse(storage.get(BOTTOM_STORAGE_KEY) ?? 'null');
  expect(adopted).toMatchObject({
    id: 'bottom',
    scope: { kind: 'ambient' },
    root: { id: 'legacy-group' },
    instances: [{ descriptorId: 'pane:builtin:chat' }],
  });
  expect(storage.get(AMBIENT_DOCK_STORAGE_KEY)).toBe(
    persistedChatDocument('chat-dock', 'legacy-group'),
  );

  // Present region key: not overwritten, whatever the legacy says.
  storage.set(
    BOTTOM_STORAGE_KEY,
    persistedChatDocument('bottom', 'region-group'),
  );
  expect(adoptLegacyChatDockDocument(adapter, 'bottom')).toBe(false);
  expect(JSON.parse(storage.get(BOTTOM_STORAGE_KEY)!).root.id).toBe(
    'region-group',
  );

  // Corrupt legacy: nothing written, no throw.
  storage.clear();
  storage.set(AMBIENT_DOCK_STORAGE_KEY, '{not json');
  expect(adoptLegacyChatDockDocument(adapter, 'right')).toBe(false);
  expect(storage.has('station:workspace-pane-host:v2:ambient:right')).toBe(
    false,
  );
});

test('the mounted host persists Chat under that same key', async () => {
  renderAmbientHost();
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  });
  await waitFor(() => {
    expect(
      window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY) ?? '',
      'the live host must write its document to the pinned key, not a renamed one',
    ).toContain('pane:builtin:chat');
  });
});

test('ambient dock renderPane mounts the canonical chat occupant through a chromeless host', () => {
  const { container } = renderAmbientHost();

  expect(
    screen.queryByTestId('ambient-chat-occupant'),
    'ambient dock renderPane must mount the canonical chat occupant',
  ).not.toBeNull();
  // `WorkspacePaneHost` itself still contributes no chrome and no element
  // (its "chromeless" contract) — the labelled "Workspace panes" container
  // belongs to a tab strip's group of panes; there is no group here. What
  // DOES wrap the occupant is `DockShell` (archive#4460): the one
  // `.chat-dock` root, a real element by design (it owns the shell's root
  // box, resize handle and geometry). The occupant is a DIRECT descendant of
  // it, not buried under a second host-owned wrapper.
  expect(screen.queryByLabelText('Workspace panes')).toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(container.querySelector('.workspace-pane-host')).toBeNull();
  const shellRoot = container.querySelector('.chat-dock');
  expect(
    shellRoot,
    'DockShell must render the shared `.chat-dock` root',
  ).not.toBeNull();
  expect(
    (shellRoot as HTMLElement).querySelector(
      '[data-testid="ambient-chat-occupant"]',
    ),
    'the occupant must render inside the shell, with no second host-owned wrapper around it',
  ).not.toBeNull();
});

test('the production ambient host refuses project-bound Basis so the launcher uses its fallback', async () => {
  render(<RegionPaneHost renderChatPane={() => <ProjectBasisLauncher />} />);

  fireEvent.click(screen.getByRole('button', { name: 'Open project Basis' }));

  expect(screen.getByRole('dialog', { name: 'Basis' })).toBeTruthy();
  expect(await screen.findByText('Basis fallback content')).toBeTruthy();
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();
  expect(
    window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY) ?? '',
  ).not.toContain('project-bound-basis');
});

/** A Home-shaped occurrence that is NOT the canonical one. */
const impostorHomeInstance = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: WORKSPACE_HOME_PANE_DESCRIPTOR.id,
  instanceId: 'workspace-home-impostor',
  stateKey: 'workspace-home-impostor',
  boundContext: { sourceId: 'builtin:workspace-home' },
})!;

/**
 * The persisted-occupant half of the admission seam (reload path). A device
 * that docked Home or Activity under a pre-C2a build still carries that
 * document; the host has no render branch for either any more, so restore
 * must retire the occupant and land on the Chat baseline — never a blank
 * dock, never a pane this host cannot render.
 */
function persistedAmbientDocument(instance: unknown) {
  return JSON.stringify({
    version: '1.1',
    id: 'chat-dock',
    scope: { kind: 'ambient' },
    instances: [instance],
    activeInstanceId: (instance as { instanceId: string }).instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [(instance as { instanceId: string }).instanceId],
      selectedInstanceId: (instance as { instanceId: string }).instanceId,
    },
  });
}

test.each([
  [
    'a canonical Home occupant',
    WORKSPACE_HOME_PANE_INSTANCE,
    'pane:builtin:home',
  ],
  ['a non-canonical Home occupant', impostorHomeInstance, 'pane:builtin:home'],
  [
    'a canonical Activity occupant',
    WORKSPACE_ACTIVITY_PANE_INSTANCE,
    'pane:builtin:activity',
  ],
])(
  'a persisted document naming %s is retired on restore: Chat renders and the stale occupant is gone',
  async (_label, instance, descriptorId) => {
    window.localStorage.setItem(
      AMBIENT_DOCK_STORAGE_KEY,
      persistedAmbientDocument(instance),
    );
    renderAmbientHost();
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    });
    expect(
      screen.getByTestId('ambient-chat-occupant').textContent,
      'the Chat baseline occurrence, not the stale one, must be what renders',
    ).toContain('workspace-chat');
    await waitFor(() => {
      expect(
        window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY) ?? '',
        'the retired occupant must not survive into the rewritten document',
      ).not.toContain(descriptorId);
    });
  },
);
