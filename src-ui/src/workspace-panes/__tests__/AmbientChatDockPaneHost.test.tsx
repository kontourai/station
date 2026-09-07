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
import {
  AMBIENT_CHAT_DOCK_DOCUMENT_ID,
  AmbientChatDockPaneHost,
  createAmbientChatDockPaneDocument,
} from '../AmbientChatDockPaneHost';
import { useBasisPaneLauncher } from '../BasisPaneLauncher';
import { workspacePaneHostStorageKey } from '../workspacePaneHostStorage';

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
    <AmbientChatDockPaneHost
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
 * silently reset every device's dock.
 */
test('the persisted dock document keeps its pre-C2b storage key', () => {
  const document = createAmbientChatDockPaneDocument();
  expect(AMBIENT_CHAT_DOCK_DOCUMENT_ID).toBe('chat-dock');
  expect(workspacePaneHostStorageKey(document.scope, document.id)).toBe(
    AMBIENT_DOCK_STORAGE_KEY,
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
  render(
    <AmbientChatDockPaneHost renderChatPane={() => <ProjectBasisLauncher />} />,
  );

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
