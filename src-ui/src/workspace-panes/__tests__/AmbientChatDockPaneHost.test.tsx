/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { ruleBodiesFor } from '../../__tests__/helpers/css-rules';
import {
  AmbientChatDockPaneHost,
  ambientWorkspacePaneDockAction,
  createAmbientChatDockPaneDocument,
} from '../AmbientChatDockPaneHost';
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

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    dockMode: 'bottom',
    isDockOpen: true,
    isDockMaximized: false,
    pathname: '/',
    setDockState: navigationMock.setDockState,
    setDockMode: () => {},
    collapseMaximizedDock: () => {},
  }),
}));

// The docked-Home tests below swap the real occupant in, and the occupant's
// render is not what they assert: the host's admission, replacement and
// persistence seams are. Stubbing the surface and its model keeps the REAL
// `HomeWorkspacePane` (and its canonical-occurrence check) in the tree
// without dragging the whole Home data graph into a host test.
vi.mock('../../views/home/useHomeViewModel', () => ({
  useHomeViewModel: () => ({}),
}));

vi.mock('../../views/home/HomeSurface', () => ({
  HomeSurface: () => <p data-testid="ambient-home-occupant">Home surface</p>,
}));

// Same stance for the docked-Activity tests: the REAL ActivityWorkspacePane
// (and its canonical-occurrence check) stays in the tree; only the sessions
// surface and its data graph are stubbed out.
vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => (
    <p data-testid="ambient-activity-occupant">Sessions surface</p>
  ),
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

test('docking the canonical Home occurrence replaces Chat and persists it', async () => {
  const action = await publishedDockAction();
  act(() => {
    action.dockPane(
      WORKSPACE_HOME_PANE_DESCRIPTOR,
      WORKSPACE_HOME_PANE_INSTANCE,
    );
  });
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();
  expect(
    window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY),
    'the ambient document must persist the Home occupant for reload survival',
  ).toContain('pane:builtin:home');
});

test('a non-canonical Home occurrence is refused: the dock admits nothing', async () => {
  const action = await publishedDockAction();
  act(() => {
    action.dockPane(WORKSPACE_HOME_PANE_DESCRIPTOR, impostorHomeInstance);
  });
  // The refusal is synchronous; the occupant and its persistence are
  // untouched, so there is nothing to wait for — assert stability.
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

test('a persisted canonical Home occupant survives a remount (the reload path)', async () => {
  window.localStorage.setItem(
    AMBIENT_DOCK_STORAGE_KEY,
    persistedAmbientDocument(WORKSPACE_HOME_PANE_INSTANCE),
  );
  renderAmbientHost();
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();
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

test('docking the canonical Activity occurrence replaces Chat and persists it (M3)', async () => {
  const action = await publishedDockAction();
  act(() => {
    action.dockPane(
      WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
      WORKSPACE_ACTIVITY_PANE_INSTANCE,
    );
  });
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-activity-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();
  expect(
    window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY),
    'the ambient document must persist the Activity occupant for reload survival',
  ).toContain('pane:builtin:activity');
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

test('a persisted canonical Activity occupant survives a remount (the reload path)', async () => {
  window.localStorage.setItem(
    AMBIENT_DOCK_STORAGE_KEY,
    persistedAmbientDocument(WORKSPACE_ACTIVITY_PANE_INSTANCE),
  );
  renderAmbientHost();
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-activity-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-chat-occupant')).toBeNull();
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
 * #765 C1 regression pin. On v0.1.2, docking a non-chat pane collapsed the
 * dock to a title-only strip: the occupant rendered outside the shared shell
 * geometry, got no height, no internal scroll, and no ⌘M — its content
 * (including any actions inside it) was unreachable until un-docked.
 * archive#4460 fixed this by making `DockShell` the single geometry authority
 * for EVERY occupant and wrapping each non-chat occupant's content in
 * `.dock-slot__body`, the one scroll container. Nothing pinned that
 * structure until now; both halves below are what "a docked non-chat pane is
 * usable" derives from:
 *
 * 1. the occupant's content mounts INSIDE `.dock-slot__body` INSIDE the
 *    `.chat-dock` shell root (the element whose height DockShell drives);
 * 2. the `.dock-slot__body` stylesheet rule actually declares the
 *    height-bearing scroll mode (`flex`, `min-height: 0`, `overflow: auto`)
 *    — jsdom applies no layout, so the class alone proves nothing without
 *    the declarations it binds.
 */
test('a docked non-chat occupant renders inside the height-bearing scroll container (#765 C1)', async () => {
  const action = await publishedDockAction();
  act(() => {
    action.dockPane(
      WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
      WORKSPACE_ACTIVITY_PANE_INSTANCE,
    );
  });
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-activity-occupant')).not.toBeNull();
  });

  const occupant = screen.getByTestId('ambient-activity-occupant');
  const body = occupant.closest('.dock-slot__body');
  expect(
    body,
    'the docked non-chat occupant must render inside `.dock-slot__body`, the shared scroll container',
  ).not.toBeNull();
  expect(
    body?.closest('.chat-dock'),
    'the scroll container must sit inside the `.chat-dock` shell whose height DockShell drives',
  ).not.toBeNull();

  const css = readFileSync(join(__dirname, '../../index.css'), 'utf-8');
  const [rule] = ruleBodiesFor(css, '.dock-slot__body');
  expect(
    rule,
    'index.css must still declare the `.dock-slot__body` rule',
  ).toBeDefined();
  expect(rule).toMatch(/flex:\s*1 1 auto/);
  expect(rule).toMatch(/min-height:\s*0/);
  expect(rule).toMatch(/overflow:\s*auto/);
});

/* ------------------------------------------------------------------ *
 * (archive#4090): the occupant picker and the published occupant. *
 * ------------------------------------------------------------------ */

/** Keeps EVERY published action so occupant-change republishes are visible. */
function mountedDockActionFeed() {
  const published: (WorkspacePaneDockAction | null)[] = [];
  renderAmbientHost((action) => published.push(action));
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

async function dockHomeAndOpenPicker() {
  const feed = mountedDockActionFeed();
  await waitFor(() => {
    expect(feed.published.some((action) => action !== null)).toBe(true);
  });
  act(() => {
    feed
      .latest()
      .dockPane(WORKSPACE_HOME_PANE_DESCRIPTOR, WORKSPACE_HOME_PANE_INSTANCE);
  });
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  });
  const trigger = screen.getByRole('button', { name: 'Docked pane: Home' });
  fireEvent.click(trigger);
  return {
    feed,
    trigger,
    menu: screen.getByRole('menu', { name: 'Docked pane' }),
  };
}

/**
 * The menu's list is the DERIVATION — every pane `ambientDockDescriptorFor`
 * admits, i.e. the same `workspacePaneModesSatisfiableBy` fold over the
 * declarations that the dockable-set contract test pins — never a curated
 * array. The expected list is recomputed here from the contracts fold so a
 * hand-curated menu (say, one that drops Activity) disagrees with the
 * derivation and fails by name.
 */
test('the occupant menu lists exactly the derived ambient-admissible panes, by name', async () => {
  const { menu } = await dockHomeAndOpenPicker();
  const derivedNames = [
    WORKSPACE_CHAT_PANE_DESCRIPTOR,
    WORKSPACE_HOME_PANE_DESCRIPTOR,
    WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  ]
    .filter(
      (descriptor) =>
        workspacePaneModesSatisfiableBy(
          descriptor,
          workspacePaneHostSuppliableContexts({ kind: 'ambient' }),
        ).length > 0,
    )
    .map((descriptor) => descriptor.name);
  expect(
    within(menu)
      .getAllByRole('menuitemradio')
      .map((item) => item.textContent),
    'the occupant menu must render the ambient admission derivation, not a curated list',
  ).toEqual(derivedNames);
  expect(
    within(menu)
      .getByRole('menuitemradio', { name: 'Home' })
      .getAttribute('aria-checked'),
    'the CURRENT occupant is the checked entry',
  ).toBe('true');
  expect(
    within(menu)
      .getByRole('menuitemradio', { name: 'Chat' })
      .getAttribute('aria-checked'),
    'Chat is one of the list, not special-cased as checked',
  ).toBe('false');
});

test('choosing another pane in the menu replaces the occupant through the existing path', async () => {
  const { menu } = await dockHomeAndOpenPicker();
  fireEvent.click(
    within(menu).getByRole('menuitemradio', { name: 'Activity' }),
  );
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-activity-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-home-occupant')).toBeNull();
  expect(
    window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY),
    'the picker must persist through the same ambient document as dockPane',
  ).toContain('pane:builtin:activity');
});

test('choosing the CURRENT occupant closes the menu without replacing anything', async () => {
  const { menu } = await dockHomeAndOpenPicker();
  const persistedBefore = window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY);
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Home' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole('menu', { name: 'Docked pane' })).toBeNull();
  expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  expect(window.localStorage.getItem(AMBIENT_DOCK_STORAGE_KEY)).toBe(
    persistedBefore,
  );
});

/**
 *no vestige: the dock-slot header's fixed "return to Chat" action is
 * deleted. Chat is one of the menu's entries, not a hardcoded header label
 * or a standing header button. Re-adding `<span>Chat</span>` or the old
 * header `WorkspacePaneDockAction` fails here.
 */
test('the dock-slot header names the occupant and carries no fixed Chat return action', async () => {
  const feed = mountedDockActionFeed();
  await waitFor(() => {
    expect(feed.published.some((action) => action !== null)).toBe(true);
  });
  act(() => {
    feed
      .latest()
      .dockPane(WORKSPACE_HOME_PANE_DESCRIPTOR, WORKSPACE_HOME_PANE_INSTANCE);
  });
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  });
  // archive#4460: Home now renders through the SAME shared `ChatDockHeader`
  // Chat does (`.chat-dock__header`), not a separate `.dock-slot__header`.
  const header = document.querySelector('.chat-dock__header');
  expect(header).not.toBeNull();
  expect(
    within(header as HTMLElement).queryByText('Chat'),
    'the header must name the OCCUPANT; a fixed "Chat" label is the retired two-pane vocabulary',
  ).toBeNull();
  expect(
    within(header as HTMLElement).queryByRole('button', {
      name: 'Dock this pane',
    }),
    'the fixed return-to-Chat header action is deleted; replacement goes through the occupant menu',
  ).toBeNull();
});

/**
 * The published action's `occupantInstanceId` is the host document's OWN
 * `activeInstanceId`, republished on every occupant change — the one source
 * of truth a route placement derives its away state from. A hand-rolled
 * route-side flag cannot follow this feed.
 */
test('the published dock action reports the live occupant and republishes it on change', async () => {
  const feed = mountedDockActionFeed();
  await waitFor(() => {
    expect(feed.published.some((action) => action !== null)).toBe(true);
  });
  expect(feed.latest().occupantInstanceId).toBe('workspace-chat');
  act(() => {
    feed
      .latest()
      .dockPane(WORKSPACE_HOME_PANE_DESCRIPTOR, WORKSPACE_HOME_PANE_INSTANCE);
  });
  await waitFor(() => {
    expect(feed.latest().occupantInstanceId).toBe(
      WORKSPACE_HOME_PANE_INSTANCE.instanceId,
    );
  });
});

test('undockOccupant restores the baseline Chat occupant (remove-from-dock semantics)', async () => {
  const feed = mountedDockActionFeed();
  await waitFor(() => {
    expect(feed.published.some((action) => action !== null)).toBe(true);
  });
  act(() => {
    feed
      .latest()
      .dockPane(WORKSPACE_HOME_PANE_DESCRIPTOR, WORKSPACE_HOME_PANE_INSTANCE);
  });
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  });
  act(() => {
    feed.latest().undockOccupant();
  });
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
  });
  expect(screen.queryByTestId('ambient-home-occupant')).toBeNull();
  await waitFor(() => {
    expect(feed.latest().occupantInstanceId).toBe('workspace-chat');
  });
});

/* ------------------------------------------------------------------ *
 * station#520: the mobile dock-and-empty contract. At phone width,
 * `dockPaneAsOnlyContent` ("Dock this pane", called by a pane on itself —
 * see `WorkspacePaneDockAction` on `WorkspacePaneDockContext` for the full
 * contract) must open the dock MAXIMIZED so the away-state placeholder
 * (`WorkspacePaneAwayState`) never renders as the viewport's only content.
 * ------------------------------------------------------------------ */

test('mobile: dockPaneAsOnlyContent maximizes the dock after a successful dock', async () => {
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
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  });
  expect(
    navigationMock.setDockState,
    'mobile self-dock must request Full (open + maximized)',
  ).toHaveBeenCalledWith(true, true);
});

test('desktop: dockPaneAsOnlyContent docks the pane but does not force Full', async () => {
  mobileFlag.isMobile = false;
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
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  });
  expect(
    navigationMock.setDockState,
    'desktop already has room beside the dock — station#520 is phone-only',
  ).not.toHaveBeenCalledWith(true, true);
});

test('mobile: a REFUSED dockPaneAsOnlyContent (non-canonical instance) never requests Full', async () => {
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
        impostorHomeInstance,
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

test('mobile: the occupant-picker path (plain dockPane) does not auto-maximize', async () => {
  // Disclosed gap (see the `dockPaneAsOnlyContent` doc): choosing an
  // occupant from the dock's own picker is a different call site than
  // "Dock this pane", and stays on the plain, non-maximizing `dockPane`.
  mobileFlag.isMobile = true;
  const feed = mountedDockActionFeed();
  await waitFor(() => {
    expect(feed.published.some((action) => action !== null)).toBe(true);
  });
  act(() => {
    feed
      .latest()
      .dockPane(WORKSPACE_HOME_PANE_DESCRIPTOR, WORKSPACE_HOME_PANE_INSTANCE);
  });
  await waitFor(() => {
    expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
  });
  expect(navigationMock.setDockState).not.toHaveBeenCalledWith(true, true);
});
