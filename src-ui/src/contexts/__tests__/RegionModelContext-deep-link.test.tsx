/** @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ActivityDockPane } from '../../app-shell/ActivityRegionShell';
import { RegionShells } from '../../app-shell/RegionShells';
import { DockShell } from '../../components/chat-dock/DockShell';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { toRegionArrangementRecord } from '../../regions/region-arrangement-record';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  placeSurface,
  updateRegion,
} from '../../regions/region-model';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { NavigationProvider } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import {
  RegionModelProvider,
  type SurfaceIntent,
  useRegionModel,
} from '../RegionModelContext';
import { useShowSurface } from '../useShowSurface';

const sessionsProps = vi.hoisted(() => vi.fn());

vi.mock('../../views/SessionsView', () => ({
  SessionsView: (props: Record<string, unknown>) => {
    sessionsProps(props);
    return <div data-testid="sessions-view" />;
  },
}));
// Chat's pane would mount the whole chat data stack; `RegionShells` is here
// as the region surface HOST, not for what it renders inside. Since #2045
// the host renders Chat through `renderAmbientChatPane`, so that is the
// seam stubbed; `ChatDock` is the model-less mount this harness never takes.
vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => <div data-testid="chat-shell" />,
  renderAmbientChatPane: () => <div data-testid="chat-shell" />,
}));
vi.mock('../ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
vi.mock('../ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  // #2047: the region host resolves the dock's project through this read;
  // no project here, so the panes that need one derive none.
  useProject: () => ({ project: undefined, isLoading: false }),
}));

let model: ReturnType<typeof useRegionModel> | null = null;

/** The live provider's model, past TypeScript's narrowing of a reset `model`. */
const liveModel = () => model as ReturnType<typeof useRegionModel> | null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

let revealSurface:
  | ((surfaceId: string, intent?: SurfaceIntent) => void)
  | null = null;

function CommandProbe() {
  const command = useShowSurface();
  useEffect(() => {
    revealSurface = command;
  }, [command]);
  return null;
}

function Harness({
  shell = false,
  host = false,
}: {
  shell?: boolean;
  /** Mount the real region surface host, as App does while it can. */
  host?: boolean;
}) {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <CommandProbe />
          {shell ? (
            // Activity as a dock pane, in the shell the region host would
            // mount around it (#2045): the pane takes the intent.
            <DockShell regionId="right">{() => <ActivityDockPane />}</DockShell>
          ) : null}
          {host ? <RegionShells /> : null}
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

/**
 * Every distinct `sessionId` the sessions surface has been rendered with since
 * the last reset. `[undefined]` means the surface mounted and was handed no
 * session at all — an assertion a single "last call" check cannot make, since
 * a re-delivery can arrive and be superseded between renders.
 */
function deliveredSessionIds(): (string | undefined)[] {
  return [
    ...new Set(
      sessionsProps.mock.calls.map(
        ([props]) => (props as { sessionId?: string }).sessionId,
      ),
    ),
  ];
}

/**
 * Prove that the placement now mounted was handed no session, WITHOUT racing
 * the delivery this must not see.
 *
 * Waiting for the sessions surface to appear and asserting no session is in
 * hand yet cannot see a re-delivery. The pane's first render necessarily
 * precedes the shell's own mount effect, so that assertion lands one render
 * BEFORE a stale intent would arrive: measured against a shell that does not
 * consume, `deliveredSessionIds()` reads `[undefined]` at the instant the
 * surface appears and `[undefined, 's1']` a tick later. It passed either way.
 *
 * So drive a LATER intent through the same shell and wait for THAT. React runs
 * the earlier effect first, so any re-delivery is already recorded by the time
 * the probe session lands — the ordering does the waiting, not a timer.
 */
async function expectFreshSurfaceThenOnly(probeSessionId: string) {
  act(() => revealSurface?.('activity', { session: probeSessionId }));
  await waitFor(() =>
    expect(sessionsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: probeSessionId }),
    ),
  );
  expect(deliveredSessionIds()).toEqual([undefined, probeSessionId]);
}

/** The shell's own landmark (`DockShell`), outside both lazy boundaries: this
 * is present iff `ActivityRegionShell` itself is mounted, where
 * `sessions-view` only reports the pane inside it. The shell holds the taken
 * intent, so "the shell unmounted" is the precondition every remount test
 * here rests on. */
function activityShellLandmark(): HTMLElement | null {
  return screen.queryByRole('region', { name: 'Activity' });
}

function setUrl(url: string) {
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

beforeEach(() => {
  model = null;
  revealSurface = null;
  sessionsProps.mockReset();
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1024,
  });
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

describe('RegionModelProvider surface deep-link adoption', () => {
  test('adopts Activity once, delivers its binding, and clears by replacement', async () => {
    setUrl('/');
    const historyLength = window.history.length;
    const rendered = render(<Harness shell />);
    await waitFor(() => expect(model).not.toBeNull());
    const updateParams = navigationStore.updateParams.bind(navigationStore);
    let deferredClear = false;
    vi.spyOn(navigationStore, 'updateParams').mockImplementation((params) => {
      if (params.surface === null && !deferredClear) {
        deferredClear = true;
        window.dispatchEvent(new PopStateEvent('popstate'));
        setTimeout(() => updateParams(params), 0);
        return;
      }
      updateParams(params);
    });
    act(() => {
      model?.setRegion('bottom', { visible: true });
      navigationStore.updateParams({
        surface: 'activity',
        session: 's1',
        focus: 'evidence',
      });
    });

    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    await waitFor(() =>
      expect(sessionsProps).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's1',
          focusHint: 'evidence',
          intentToken: 1,
        }),
      ),
    );
    expect(window.location.search).toBe('?dock=open');
    expect(window.history.length).toBe(historyLength);
    // Delivered means GONE from the model: the mounted shell took the record,
    // and that take — not a ref inside the consumer — is the consumption
    // record, so it survives the consumer's unmount.
    expect(model?.surfaceIntents.activity).toBeUndefined();

    rendered.unmount();
    render(<Harness />);
    await act(async () => undefined);
    expect(model?.surfaceIntents.activity).toBeUndefined();

    window.dispatchEvent(new PopStateEvent('popstate'));
    await act(async () => undefined);
    expect(model?.surfaceIntents.activity).toBeUndefined();
  });

  test('adopts the same link again after its one-shot was consumed', async () => {
    setUrl('/?surface=activity&session=s1');
    render(<Harness />);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(model?.surfaceIntents.activity?.token).toBe(1);

    setUrl('/?surface=activity&session=s1');
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(model?.surfaceIntents.activity?.token).toBe(2);
  });

  // `activityDeepLink()` with no session mints a bare `/?surface=activity`.
  // Adopting it must reveal Activity WITHOUT an intent object, which is what
  // makes `showSurface` DROP the undelivered record rather than leave it
  // standing: no placement is mounted here, so leaving it would hand the next
  // mount a session this reveal never named.
  test('a sessionless deep link reveals Activity without re-delivering a previous session', async () => {
    setUrl('/?surface=activity&session=thread%2Falpha');
    const rendered = render(<Harness />);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(model?.surfaceIntents.activity).toEqual({
      session: 'thread/alpha',
      focus: undefined,
      token: 1,
    });

    act(() => model?.setRegion('right', { visible: false }));
    await waitFor(() => expect(model?.regions.right.visible).toBe(false));

    setUrl('/?surface=activity');

    await waitFor(() => expect(model?.regions.right.visible).toBe(true));
    expect(model?.regions.right.occupant).toBe('activity');
    expect(model?.surfaceIntents.activity).toBeUndefined();

    // An emptied outbox is only the mechanism; the deliverable is that the
    // placement this reveal mounts is handed no session. Mount the host now —
    // nothing was ever delivered to a consumer, so a record left standing here
    // would arrive as a first delivery, which is the whole hazard.
    sessionsProps.mockReset();
    expect(activityShellLandmark()).toBeNull();
    rendered.rerender(<Harness host />);
    await waitFor(() => expect(activityShellLandmark()).not.toBeNull());
    await expectFreshSurfaceThenOnly('s9');
  });

  // The bottom-only half was "folds to Activity" (Activity in `right`, Chat's
  // region hidden) until the phone layer: a phone now opens a deep-linked
  // surface OVER Chat, in Chat's region, so Back returns to the conversation.
  test('preserves dock ordering on desktop and opens Activity over Chat on bottom-only devices', async () => {
    setUrl('/?dock=open&surface=activity');
    const desktop = render(<Harness />);
    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    expect(model?.regions.bottom).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
    });
    desktop.unmount();

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    setUrl('/?dock=open&surface=activity');
    render(<Harness />);

    await waitFor(() =>
      expect(model?.regions.bottom).toMatchObject({
        panes: ['chat', 'activity'],
        occupant: 'activity',
        visible: true,
      }),
    );
    // The deep link's own params are consumed; the dock stays open.
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('surface')).toBe(
        null,
      ),
    );
    expect(model?.regions.right.panes).toEqual([]);
    expect(model?.lastShownRegion).toBe('bottom');
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
    expect(model?.phoneLayer).toEqual({
      region: 'bottom',
      surfaceId: 'activity',
    });
  });

  // Was "folding a maximized Chat away keeps lastDockMaximized": before the
  // phone layer, showing Activity on a phone hid Chat's region, and the
  // assertion was that the close kept the maximize memory (archive#945). The
  // layer no longer closes Chat's region, so the memory is kept by never
  // being touched, and Back returns to the maximized Chat.
  test('showing Activity over a maximized Chat on a bottom-only device keeps the maximize and its memory', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    setUrl('/?dock=open&maximize=true');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);

    act(() => model?.showSurface('activity'));

    await waitFor(() =>
      expect(model?.regions.bottom.occupant).toBe('activity'),
    );
    expect(model?.regions.bottom).toMatchObject({
      visible: true,
      maximized: true,
    });
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
    expect(new URLSearchParams(window.location.search).get('maximize')).toBe(
      'true',
    );
    expect(navigationStore.lastDockMaximized).toBe(true);

    act(() => window.history.back());
    await waitFor(() => expect(model?.regions.bottom.occupant).toBe('chat'));
    expect(model?.regions.bottom.maximized).toBe(true);
    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  test('clears an unknown surface without changing the layout', async () => {
    setUrl('/?surface=unknown&session=s1');
    render(<Harness />);

    await waitFor(() => expect(window.location.search).toBe(''));
    expect(model?.regions.right.occupant).toBeNull();
    expect(model?.surfaceIntents.unknown).toBeUndefined();
  });

  test('delivers repeated mounted intents and consumes focus without losing the session', async () => {
    render(<Harness shell />);
    await waitFor(() => expect(model).not.toBeNull());

    act(() =>
      model?.showSurface('activity', { session: 's2', focus: 'evidence' }),
    );
    // Asserted through the binding the shell hands down, not the model: the
    // mounted shell TAKES the record, so an empty outbox is what delivery
    // looks like from the model's side.
    await waitFor(() =>
      expect(sessionsProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: 's2',
          focusHint: 'evidence',
          intentToken: 1,
        }),
      ),
    );
    expect(model?.surfaceIntents.activity).toBeUndefined();

    const binding = sessionsProps.mock.lastCall?.[0] as
      | { onFocusConsumed?: () => void }
      | undefined;
    act(() => binding?.onFocusConsumed?.());
    await waitFor(() =>
      expect(sessionsProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: 's2',
          focusHint: undefined,
          intentToken: 1,
        }),
      ),
    );

    // A repeat activation of the same session is a NEW instruction, and the
    // already-mounted shell must see it: a fresh token under the same session.
    act(() =>
      model?.showSurface('activity', { session: 's2', focus: 'evidence' }),
    );
    await waitFor(() =>
      expect(sessionsProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: 's2',
          focusHint: 'evidence',
          intentToken: 2,
        }),
      ),
    );
    expect(model?.surfaceIntents.activity).toBeUndefined();
  });
});

/**
 * #928 C2a. Home is a region surface whose only placement is `main`, and
 * `main` is the route outlet at `/`. Placing a surface there from any other
 * route would change state nothing renders, so the provider — the one place
 * that knows the placement landed in `main` — navigates to `/` after the
 * state write, through the store call `useShowSurface` makes.
 */
/**
 * 2a review (MEDIUM): Chat's inbound links act on Chat's region and used to
 * leave another pane's tab selected there. Each seeds the persisted record
 * with Chat BEHIND Activity's tab in `bottom` (the 2a join), then arrives by
 * the link. The URL's Chat params also persist across reloads, so a param
 * that merely repeats what the record holds is a reload, not a link, and
 * the record's selection — the user's last tab choice — stands.
 * Reverting the `selectRegionPane`/`occupant: 'chat'` writes in
 * `initialRegionPlacement`, `initialRegionArrangement` and the inbound
 * navigation effect fails the matching `occupant: 'chat'` assertion;
 * selecting Chat unconditionally fails the `occupant: 'activity'` ones.
 */
describe('Chat’s inbound links select Chat’s tab (#2046 2b)', () => {
  function seedChatBehindActivity(patch: {
    visible: boolean;
    maximized?: boolean;
  }) {
    const arrangement = updateRegion(
      placeSurface(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'activity', 'bottom'),
      'bottom',
      patch,
    );
    expect(arrangement.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      ...patch,
    });
    deviceSettingsStore.set(
      'regionArrangement',
      toRegionArrangementRecord(arrangement),
    );
  }

  test('?dockSlotPlacement= that moves Chat selects its tab; one that names where Chat already is leaves the record’s tab', async () => {
    seedChatBehindActivity({ visible: true });
    setUrl('/?dockSlotPlacement=right');
    const moved = render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(liveModel()?.regions.right).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
    });
    expect(liveModel()?.regions.bottom).toMatchObject({
      panes: ['activity'],
      occupant: 'activity',
    });
    moved.unmount();
    model = null;

    // The reload shape: the URL remembers `bottom`, which the record holds.
    seedChatBehindActivity({ visible: true });
    setUrl('/?dockSlotPlacement=bottom&dock=open');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(liveModel()?.regions.bottom).toMatchObject({
      panes: ['chat', 'activity'],
      occupant: 'activity',
      visible: true,
    });
  });

  test('dock=open at load shows Chat’s tab only when it shows the region', async () => {
    seedChatBehindActivity({ visible: false });
    setUrl('/?dock=open');
    const opened = render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(liveModel()?.regions.bottom).toMatchObject({
      occupant: 'chat',
      visible: true,
    });
    opened.unmount();
    model = null;

    seedChatBehindActivity({ visible: true });
    setUrl('/?dock=open');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(liveModel()?.regions.bottom).toMatchObject({
      occupant: 'activity',
      visible: true,
    });
  });

  test('?maximize=true selects Chat’s tab when it is the URL’s maximize, not the record’s', async () => {
    seedChatBehindActivity({ visible: true });
    setUrl('/?dock=open&maximize=true');
    const maximized = render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(liveModel()?.regions.bottom).toMatchObject({
      occupant: 'chat',
      maximized: true,
      visible: true,
    });
    maximized.unmount();
    model = null;

    seedChatBehindActivity({ visible: true, maximized: true });
    setUrl('/?dock=open&maximize=true');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(liveModel()?.regions.bottom).toMatchObject({
      occupant: 'activity',
      maximized: true,
    });
  });

  test('an inbound dock=open (a focusSession reveal) shows Chat’s tab, and a later maximize keeps it', async () => {
    seedChatBehindActivity({ visible: false });
    setUrl('/');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(liveModel()?.regions.bottom).toMatchObject({
      occupant: 'activity',
      visible: false,
    });

    act(() => navigationStore.setDockState(true, false));
    await waitFor(() =>
      expect(liveModel()?.regions.bottom).toMatchObject({
        occupant: 'chat',
        visible: true,
      }),
    );

    // Activity's tab again, then a maximize arriving through navigation:
    // Chat's tab, since the maximize is Chat's.
    act(() => liveModel()?.selectPane('bottom', 'activity'));
    await waitFor(() =>
      expect(liveModel()?.regions.bottom.occupant).toBe('activity'),
    );
    act(() => navigationStore.setDockState(true, true));
    await waitFor(() =>
      expect(liveModel()?.regions.bottom).toMatchObject({
        occupant: 'chat',
        maximized: true,
      }),
    );
  });
});

describe('a placement into main navigates to the route outlet', () => {
  test('showSurface(home) from another route places Home in main and navigates to /', async () => {
    setUrl('/settings');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    const navigate = vi.spyOn(navigationStore, 'navigate');

    act(() => model?.showSurface('home'));

    expect(navigate).toHaveBeenCalledWith('/');
    expect(window.location.pathname).toBe('/');
    await waitFor(() => expect(model?.regions.main.occupant).toBe('home'));
    expect(model?.lastShownRegion).toBe('main');
  });

  test('placeSurface(activity, main) from another route navigates to /; a dock placement does not', async () => {
    setUrl('/plugins');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    const navigate = vi.spyOn(navigationStore, 'navigate');

    act(() => model?.placeSurface('activity', 'right'));
    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    expect(navigate).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/plugins');

    act(() => model?.placeSurface('activity', 'main'));

    expect(navigate).toHaveBeenCalledWith('/');
    expect(window.location.pathname).toBe('/');
    await waitFor(() => expect(model?.regions.main.occupant).toBe('activity'));
    // Displacement from `main` unplaces: Home is in no region now.
    expect(
      (['main', 'left', 'right', 'bottom'] as const).some(
        (id) => model?.regions[id].occupant === 'home',
      ),
    ).toBe(false);
  });

  test('showSurface(activity) from another route reveals it in a dock region and stays put', async () => {
    setUrl('/plugins');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    const navigate = vi.spyOn(navigationStore, 'navigate');

    act(() => model?.showSurface('activity'));

    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    expect(navigate).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/plugins');
  });

  test('the ?surface=home deep link places Home back in main', async () => {
    setUrl('/');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    act(() => model?.placeSurface('activity', 'main'));
    await waitFor(() => expect(model?.regions.main.occupant).toBe('activity'));

    setUrl('/?surface=home');

    await waitFor(() => expect(model?.regions.main.occupant).toBe('home'));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/');
    // Unplaced, not relocated: Activity is in no dock region.
    expect(model?.regions.right.occupant).toBeNull();
    expect(model?.regions.left.occupant).toBeNull();
  });

  test('a refused placement (a region the surface does not declare) neither places nor navigates', async () => {
    setUrl('/plugins');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    const navigate = vi.spyOn(navigationStore, 'navigate');

    act(() => model?.placeSurface('chat', 'main'));
    act(() => model?.placeSurface('home', 'right'));
    await act(async () => undefined);

    expect(navigate).not.toHaveBeenCalled();
    expect(model?.regions.main.occupant).toBe('home');
    expect(model?.regions.right.occupant).toBeNull();
  });
});

/**
 * #928. `showSurface` only mutates region-model state, and `App.tsx` mounts
 * `RegionShells` — the one host that renders a region surface — solely while
 * `showAmbientChatDock` holds. While a Chat workspace layout is the current
 * view there is no host, so every commanded reveal used to change state
 * nothing rendered: the click did nothing at all.
 *
 * Both halves are driven through the shipped hook rather than the model, and
 * the host is the real `RegionShells` rather than a stand-in for it, because
 * "the model was told" is exactly the assertion that could not see the defect.
 */
describe('useShowSurface reveals a surface even where no region host renders', () => {
  test('commands the region model while the host is mounted', async () => {
    setUrl('/');
    render(<Harness host />);
    await waitFor(() => expect(model?.canRenderRegionSurfaces).toBe(true));
    const navigate = vi.spyOn(navigationStore, 'navigate');

    act(() => revealSurface?.('activity', { session: 's1' }));

    expect(navigate).not.toHaveBeenCalled();
    expect(
      new URLSearchParams(window.location.search).get('surface'),
    ).toBeNull();
    expect(model?.regions.right.occupant).toBe('activity');
    expect(model?.surfaceIntents.activity).toMatchObject({ session: 's1' });
  });

  test('navigates to the canonical deep link from a Chat workspace layout, and the adoption effect reveals the surface there', async () => {
    setUrl('/projects/demo/layouts/chat');
    render(<Harness />);
    await waitFor(() => expect(model).not.toBeNull());
    expect(model?.canRenderRegionSurfaces).toBe(false);
    const navigate = vi.spyOn(navigationStore, 'navigate');

    act(() =>
      revealSurface?.('activity', { session: 's1', focus: 'evidence' }),
    );

    expect(navigate).toHaveBeenCalledWith(
      '/?surface=activity&session=s1&focus=evidence',
    );
    // The link is not the deliverable — the revealed surface is. Leaving the
    // layout is what mounts a host, and the provider's adoption effect is
    // what turns the minted link back into a reveal carrying the intent.
    await waitFor(() => expect(model?.regions.right.occupant).toBe('activity'));
    expect(window.location.pathname).toBe('/');
    expect(model?.surfaceIntents.activity).toMatchObject({
      session: 's1',
      focus: 'evidence',
    });
  });

  test('stops commanding the model the moment the host unmounts', async () => {
    setUrl('/');
    const rendered = render(<Harness host />);
    await waitFor(() => expect(model?.canRenderRegionSurfaces).toBe(true));

    rendered.rerender(<Harness />);
    await waitFor(() => expect(model?.canRenderRegionSurfaces).toBe(false));

    const navigate = vi.spyOn(navigationStore, 'navigate');
    act(() => revealSurface?.('activity'));

    expect(navigate).toHaveBeenCalledWith('/?surface=activity');
  });
});

/**
 * #928. A surface intent is a ONE-SHOT instruction ("reveal Activity, select
 * session X"). Every consumption record downstream of the model is
 * mount-scoped — `SessionsView`'s `routedIntentTokenRef` is a ref that dies at
 * unmount — while the record itself lived in the model and outlived it. So an
 * unmount/remount handed the SAME instruction to the new mount as new, and the
 * reader who asked for Activity got session X reopened instead, possibly long
 * after and with no relation to what they clicked.
 *
 * Both tests here drive a REAL unmount of the placement (`RegionShells`
 * dropping the shell, and `App` dropping the host) rather than poking the
 * model, because "the model's state is right" is exactly the assertion that
 * cannot see this defect: the whole bug is the record outliving its consumer.
 */
describe('a delivered surface intent is never delivered a second time', () => {
  function stubBottomOnlyDevice() {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  }

  test('folding Chat in front of Activity and revealing Activity again opens no session', async () => {
    stubBottomOnlyDevice();
    setUrl('/');
    render(<Harness host />);
    await waitFor(() => expect(model?.canRenderRegionSurfaces).toBe(true));

    act(() => revealSurface?.('activity', { session: 's1' }));
    await waitFor(() =>
      expect(sessionsProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: 's1' }),
      ),
    );

    // On a bottom-only device Activity opens OVER Chat (the phone layer), as
    // a tab of Chat's region, so its landmark is Chat's shell and the thing
    // that mounts and unmounts is the Activity PANE — which is what holds
    // the taken intent (`ActivityDockPane`). Revealing Chat selects Chat's
    // tab, and the region host mounts only the selected pane: Activity
    // genuinely UNMOUNTS, taking every consumption record inside it.
    // Asserted on the DOM rather than on region state, because a
    // still-mounted pane would make the rest of this test vacuous.
    act(() => revealSurface?.('chat'));
    await waitFor(() =>
      expect(screen.queryByTestId('sessions-view')).toBeNull(),
    );
    // `findBy`: since #2045 Chat's pane renders through the region host's
    // lazy boundary rather than an eagerly stubbed shell.
    expect(await screen.findByTestId('chat-shell')).toBeTruthy();

    sessionsProps.mockReset();

    // Reveal Activity generically — the sidebar, the palette, ⌘⇧A and "All
    // activity" all land here, carrying no session.
    act(() => revealSurface?.('activity'));
    await waitFor(() =>
      expect(screen.queryByTestId('sessions-view')).not.toBeNull(),
    );
    await expectFreshSurfaceThenOnly('s9');
  });

  test('leaving the region host and coming back re-opens no session, with no reveal in between', async () => {
    setUrl('/');
    const rendered = render(<Harness host />);
    await waitFor(() => expect(model?.canRenderRegionSurfaces).toBe(true));

    act(() => revealSurface?.('activity', { session: 's1' }));
    await waitFor(() =>
      expect(sessionsProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: 's1' }),
      ),
    );

    // `App` mounts `RegionShells` only while `showAmbientChatDock` holds, so a
    // Chat workspace layout takes the host — and with it the shell — away and
    // gives it back on return. Nothing commands a reveal across this, which is
    // what makes it a test of the CONSUMPTION record rather than of the
    // clear-on-generic-reveal path the previous test drives.
    rendered.rerender(<Harness />);
    await waitFor(() => expect(model?.canRenderRegionSurfaces).toBe(false));
    // The SHELL is gone, not merely the pane inside it: the shell is where the
    // taken intent lives, so nothing below this line means anything unless the
    // shell instance itself was destroyed.
    expect(activityShellLandmark()).toBeNull();
    expect(screen.queryByTestId('sessions-view')).toBeNull();

    sessionsProps.mockReset();
    rendered.rerender(<Harness host />);
    await waitFor(() => expect(activityShellLandmark()).not.toBeNull());
    await expectFreshSurfaceThenOnly('s9');
  });
});
