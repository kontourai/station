/** @vitest-environment jsdom */

import { createDirectAnswerBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-chat-pane';
import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import {
  parseWorkspacePaneInstance,
  workspacePaneModesSatisfiableBy,
} from '@kontourai/station-contracts/workspace-pane';
import { workspacePaneHostSuppliableContexts } from '@kontourai/station-contracts/workspace-pane-host';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChatDockHeader } from '../../components/chat-dock/ChatDockHeader';
import {
  AmbientChatDockPaneHost,
  ambientWorkspacePaneDockAction,
  createAmbientChatDockPaneDocument,
} from '../AmbientChatDockPaneHost';
import { AMBIENT_DOCK_RENDERABLE_PANES } from '../ambientDockOccupants';
import { useBasisPaneLauncher } from '../BasisPaneLauncher';
import type { WorkspacePaneDockAction } from '../WorkspacePaneDockContext';

vi.mock('../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    chatDockHeight: 320,
    chatDockWidth: 400,
  }),
  // `DockShell` (archive#4460) owns dock chrome now, including the
  // drag-end device-settings commit `useChatDockState` used to own.
  useDeviceSettingsActions: () => ({ setDeviceSetting: () => {} }),
}));

// station#520: `setDockState` is a spy (not a bare no-op) so the
// mobile-dock-and-empty tests below can assert `dockPaneAsOnlyContent`
// actually requests Full (`setDockState(true, true)`) rather than only
// checking DOM state a fully-mocked navigation context can't reflect.
const navigationMock = vi.hoisted(() => ({ setDockState: vi.fn() }));
// station#520: `useIsMobile` is real (unmocked) elsewhere in this file,
// which is correctly "desktop" in jsdom's default viewport — the
// mobile-dock-and-empty tests below flip this flag to exercise the phone
// branch without needing a real `matchMedia` breakpoint match.
const mobileFlag = vi.hoisted(() => ({ isMobile: false }));
vi.mock('../../hooks/useIsMobile', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../hooks/useIsMobile')>();
  return { ...actual, useIsMobile: () => mobileFlag.isMobile };
});

// station#520 (review round 2, M3): `DockOccupantPicker`'s onChoose seam now
// reads `pathname` too — mutable so the picker tests below can exercise
// both "on this pane's own route" and "somewhere else" without a real
// router.
const pathnameFlag = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    dockMode: 'bottom',
    isDockOpen: true,
    isDockMaximized: false,
    get pathname() {
      return pathnameFlag.pathname;
    },
    setDockState: navigationMock.setDockState,
    setDockMode: () => {},
    collapseMaximizedDock: () => {},
  }),
}));

// #928 C2a: Home is a region surface whose only placement is `main`, so the
// legacy ambient host no longer admits it (`AMBIENT_DOCK_RENDERABLE_PANES`
// is Chat only). The Home stubs stay so the refusal tests below can prove
// the Home render branch is NOT reached — an admitted Home would render this
// marker.
vi.mock('../../views/home/useHomeViewModel', () => ({
  useHomeViewModel: () => ({}),
}));

vi.mock('../../views/home/HomeSurface', () => ({
  HomeSurface: () => <p data-testid="ambient-home-occupant">Home surface</p>,
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => null,
}));

vi.mock('../BasisPaneFallbackContent', () => ({
  ConnectedBasisFallbackPane: () => <p>Basis fallback content</p>,
}));

// archive#4525: `DockShell` (via `useDockShellChrome`) now reads `useProjects`
// for its project-binding deletion cleanup. Mocked here the same way every
// other unrelated context in this file is — this suite is about occupant
// admission/replacement, not project binding (see
// `AmbientChatDockProjectBinding.test.tsx` for that).
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

const AMBIENT_DOCK_STORAGE_KEY =
  'station:workspace-pane-host:v2:ambient:chat-dock';

/**
 * jsdom has no Web Locks, and the ambient host deliberately exposes no
 * lockManager prop — it IS the production wiring. Granting the lock through
 * `navigator.locks` exercises the same `browserWorkspacePaneHostLockManager`
 * path production takes.
 */
beforeEach(() => {
  mobileFlag.isMobile = false;
  pathnameFlag.pathname = '/';
  navigationMock.setDockState.mockClear();
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

function renderAmbientHost(
  onDockActionChange?: (action: WorkspacePaneDockAction | null) => void,
) {
  return render(
    <AmbientChatDockPaneHost
      renderChatPane={(instance) => (
        <p data-testid="ambient-chat-occupant">
          Chat pane {instance.instanceId}
        </p>
      )}
      onDockActionChange={onDockActionChange}
    />,
  );
}

function renderAmbientHostWithChatHeader(
  onDockActionChange?: (action: WorkspacePaneDockAction | null) => void,
) {
  return render(
    <AmbientChatDockPaneHost
      renderChatPane={(instance, _onRequestAuth, shellChrome) => (
        <>
          <ChatDockHeader
            regionVisible={shellChrome.isDockOpen}
            shellMaximized={shellChrome.isDockMaximized}
            canMaximize={shellChrome.canMaximize}
            surfaceShortcutId={shellChrome.surfaceShortcutId}
            isDragging={shellChrome.isDragging}
            onDockSnap={shellChrome.applyDockSnap}
            availableDockSlotPlacements={
              shellChrome.availableDockSlotPlacements
            }
            effectiveDockSlotPlacement={shellChrome.effectiveDockSlotPlacement}
            onDockPlacementChange={shellChrome.commitDockPlacement}
            occupantPicker={shellChrome.occupantPicker}
          />
          <p data-testid="ambient-chat-occupant">
            Chat pane {instance.instanceId}
          </p>
        </>
      )}
      onDockActionChange={onDockActionChange}
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

async function publishedDockAction(): Promise<WorkspacePaneDockAction> {
  const published: (WorkspacePaneDockAction | null)[] = [];
  renderAmbientHost((action) => published.push(action));
  await waitFor(() => {
    expect(published.some((action) => action !== null)).toBe(true);
  });
  for (let index = published.length - 1; index >= 0; index -= 1) {
    const action = published[index];
    if (action) return action;
  }
  throw new Error('no dock action published');
}

/** A Home-shaped occurrence that is NOT the canonical one. */
const impostorHomeInstance = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: WORKSPACE_HOME_PANE_DESCRIPTOR.id,
  instanceId: 'workspace-home-impostor',
  stateKey: 'workspace-home-impostor',
  boundContext: { sourceId: 'builtin:workspace-home' },
})!;

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

test('ambient dock renderPane mounts the canonical chat occupant through a chromeless host', () => {
  const { container } = render(
    <AmbientChatDockPaneHost
      renderChatPane={(instance) => (
        <p data-testid="ambient-chat-occupant">
          Chat pane {instance.instanceId}
        </p>
      )}
    />,
  );

  expect(
    screen.queryByTestId('ambient-chat-occupant'),
    'ambient dock renderPane must mount the canonical chat occupant',
  ).not.toBeNull();
  // `WorkspacePaneHost` itself still contributes no chrome and no element
  // (its "chromeless" contract) — the labelled "Workspace panes" container
  // belongs to a tab strip's group of panes; there is no group here. What
  // DOES wrap the occupant now is `DockShell` (archive#4460): the one
  // `.chat-dock` root every occupant shares, a real element by design (it
  // owns the shell's root box, resize handle and geometry). The occupant is
  // a DIRECT descendant of it, not buried under a second host-owned wrapper.
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

/**
 * The dock action trusts the host's reported `suppliable` blindly — by
 * design, so a second host with a different scope works through the same
 * context. The trust is honest only if this binding holds: a host reporting
 * contexts its scope does not own would make every matching pane's dock
 * action appear with nothing able to bind it. Caught by injection:
 * hand-writing `new Set(['project', 'task'])` in the published action passed
 * every other test.
 */
test('the published dock action reports EXACTLY the ambient scope derivation', () => {
  const action = ambientWorkspacePaneDockAction(
    () => {},
    () => {},
    'workspace-chat',
    () => {},
  );
  expect([...action.suppliable].sort()).toEqual(
    [...workspacePaneHostSuppliableContexts({ kind: 'ambient' })].sort(),
  );
});

/**
 * Regression pin for the wiring that kept "Dock this pane" off every route
 * (archive#4090): `onDockSlotActionChange={setReplace}` handed the host's
 * replace FUNCTION straight to a state setter, which React treats as an
 * updater — the stored state became `controller.replace(null)` (a boolean),
 * so the published action was permanently null. The docked-slot unit test
 * captured the authority with a `vi.fn` and never saw it. This test goes
 * through the REAL mounted host and the REAL App-facing callback.
 */
test('the mounted ambient host publishes a live dock action, not null forever', async () => {
  const action = await publishedDockAction();
  expect(typeof action.dockPane).toBe('function');
  expect([...action.suppliable].sort()).toEqual(
    [...workspacePaneHostSuppliableContexts({ kind: 'ambient' })].sort(),
  );
});

/**
 * #928 C2a: Home left this host for the region registry (its only placement
 * is `main`), so the ambient dock refuses it exactly as it refuses Activity —
 * on a live dock request, and on restore of a persisted document that still
 * names it. The Home render branch (`AmbientHomeDock`) is legacy plumbing
 * awaiting C2b; these prove nothing reaches it.
 */
test('the legacy ambient dock refuses the canonical Home occurrence', async () => {
  const action = await publishedDockAction();
  act(() => {
    action.dockPane(
      WORKSPACE_HOME_PANE_DESCRIPTOR,
      WORKSPACE_HOME_PANE_INSTANCE,
    );
  });
  await act(async () => Promise.resolve());
  expect(screen.queryByTestId('ambient-home-occupant')).toBeNull();
  expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  expect(
    window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY) ?? '',
    'Home belongs to the region registry and must not enter the legacy ambient document',
  ).not.toContain('pane:builtin:home');
});

test('a non-canonical Home occurrence is refused: the dock admits nothing', async () => {
  const action = await publishedDockAction();
  act(() => {
    action.dockPane(WORKSPACE_HOME_PANE_DESCRIPTOR, impostorHomeInstance);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByTestId('ambient-home-occupant')).toBeNull();
  expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  expect(
    window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY) ?? '',
    'a refused occurrence must never reach the persisted document',
  ).not.toContain('pane:builtin:home');
});

/** The persisted-occupant halves of the same admission seam (reload path). */
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

test('a persisted canonical Home occupant is retired on restore: Chat renders', async () => {
  window.localStorage.setItem(
    AMBIENT_DOCK_STORAGE_KEY,
    persistedAmbientDocument(WORKSPACE_HOME_PANE_INSTANCE),
  );
  renderAmbientHost();
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-home-occupant')).toBeNull();
});

test('a persisted non-canonical Home occupant is refused on restore: Chat renders', async () => {
  window.localStorage.setItem(
    AMBIENT_DOCK_STORAGE_KEY,
    persistedAmbientDocument(impostorHomeInstance),
  );
  renderAmbientHost();
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-home-occupant')).toBeNull();
});

/** An Activity-shaped occurrence that is NOT the canonical one. */
const impostorActivityInstance = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.id,
  instanceId: 'workspace-activity-impostor',
  stateKey: 'workspace-activity-impostor',
  boundContext: { sourceId: 'builtin:workspace-activity' },
})!;

test('the legacy ambient dock refuses the canonical Activity occurrence', async () => {
  const action = await publishedDockAction();
  act(() => {
    action.dockPane(
      WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
      WORKSPACE_ACTIVITY_PANE_INSTANCE,
    );
  });
  await act(async () => Promise.resolve());
  expect(screen.queryByTestId('ambient-activity-occupant')).toBeNull();
  expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  expect(
    window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY) ?? '',
    'Activity belongs to the region registry and must not enter the legacy ambient document',
  ).not.toContain('pane:builtin:activity');
});

test('a non-canonical Activity occurrence is refused: the dock admits nothing', async () => {
  const action = await publishedDockAction();
  act(() => {
    action.dockPane(
      WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
      impostorActivityInstance,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByTestId('ambient-activity-occupant')).toBeNull();
  expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  expect(
    window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY) ?? '',
    'a refused occurrence must never reach the persisted document',
  ).not.toContain('pane:builtin:activity');
});

test('a persisted canonical Activity occupant is retired on restore', async () => {
  window.localStorage.setItem(
    AMBIENT_DOCK_STORAGE_KEY,
    persistedAmbientDocument(WORKSPACE_ACTIVITY_PANE_INSTANCE),
  );
  renderAmbientHost();
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-activity-occupant')).toBeNull();
});

test('a persisted non-canonical Activity occupant is refused on restore: Chat renders', async () => {
  window.localStorage.setItem(
    AMBIENT_DOCK_STORAGE_KEY,
    persistedAmbientDocument(impostorActivityInstance),
  );
  renderAmbientHost();
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-activity-occupant')).toBeNull();
});

/**
 * #928 C2a retired the docked-Home cases that used to live here — the
 * occupant picker's derived list, choosing another pane, the header naming
 * its occupant, `occupantInstanceId` republishing on change, `undockOccupant`
 * restoring Chat. Every one of them docked Home to get a second ambient
 * occupant, and Chat is now the only pane this host admits, so there is no
 * occupant switch left to drive. The pure derivations they rested on
 * (`ambientDockOccupantChoices`, `chooseAmbientOccupant`) keep their own
 * tests in `mobile-chrome-safety.test.ts`; the host's occupant-switch
 * machinery is legacy plumbing awaiting C2b.
 */

/** Keeps EVERY published action so occupant-change republishes are visible. */
function mountedDockActionFeed(
  mount: typeof renderAmbientHost = renderAmbientHost,
) {
  const published: (WorkspacePaneDockAction | null)[] = [];
  mount((action) => published.push(action));
  return {
    published,
    latest(): WorkspacePaneDockAction {
      for (let index = published.length - 1; index >= 0; index -= 1) {
        const action = published[index];
        if (action) return action;
      }
      throw new Error('no dock action published');
    },
  };
}

test('the published dock action reports the live occupant', async () => {
  const feed = mountedDockActionFeed();
  await waitFor(() => {
    expect(feed.published.some((action) => action !== null)).toBe(true);
  });
  expect(feed.latest().occupantInstanceId).toBe('workspace-chat');
});

test('the occupant picker offers only Chat: the derived ambient-admissible list is Chat alone', async () => {
  const feed = mountedDockActionFeed(renderAmbientHostWithChatHeader);
  await waitFor(() =>
    expect(feed.published.some((action) => action !== null)).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Docked pane: Chat' }));
  const menu = screen.getByRole('menu', { name: 'Docked pane' });
  const derivedNames = [
    WORKSPACE_CHAT_PANE_DESCRIPTOR,
    WORKSPACE_HOME_PANE_DESCRIPTOR,
  ]
    .filter(
      (descriptor) =>
        AMBIENT_DOCK_RENDERABLE_PANES.some(
          (pane) => pane.descriptor.id === descriptor.id,
        ) &&
        workspacePaneModesSatisfiableBy(
          descriptor,
          workspacePaneHostSuppliableContexts({ kind: 'ambient' }),
        ).length > 0,
    )
    .map((descriptor) => descriptor.name);
  expect(derivedNames).toEqual(['Chat']);
  expect(
    within(menu)
      .getAllByRole('menuitemradio')
      .map((item) => item.textContent),
    'the occupant menu must render the ambient admission derivation, not a curated list',
  ).toEqual(derivedNames);
});

/* ------------------------------------------------------------------ *
 * station#520: the mobile dock-and-empty contract. At phone width,
 * `dockPaneAsOnlyContent` must open the dock MAXIMIZED after a SUCCESSFUL
 * dock and never after a refused one. With Chat the only admissible pane
 * (#928 C2a) there is no successful non-Chat dock left to drive here; the
 * maximize derivation itself is pinned in `mobile-chrome-safety.test.ts`
 * (`shouldMaximizeAfterDockingAsOnlyContent`). What this host still proves
 * is the refusal half.
 * ------------------------------------------------------------------ */

test('mobile: a REFUSED dockPaneAsOnlyContent (Home, no longer admitted) never requests Full', async () => {
  mobileFlag.isMobile = true;
  const feed = mountedDockActionFeed();
  await waitFor(() => {
    expect(feed.published.some((action) => action !== null)).toBe(true);
  });
  act(() => {
    feed
      .latest()
      .dockPaneAsOnlyContent(
        WORKSPACE_HOME_PANE_DESCRIPTOR,
        WORKSPACE_HOME_PANE_INSTANCE,
      );
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByTestId('ambient-home-occupant')).toBeNull();
  expect(
    navigationMock.setDockState,
    'maximizing a request the admission check refused would open the dock over nothing',
  ).not.toHaveBeenCalled();
});
