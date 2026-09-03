/** @vitest-environment jsdom */

/**
 * archive#4525: the dock's project binding is DockShell-owned state
 * (`useDockShellChrome`'s `activeProjectSlug`/`setActiveProjectSlug`), not a
 * derivation of whichever chat session happens to be active. The
 * Phase-1 investigation found the ACTUAL reset mechanism: the chromeless
 * `WorkspacePaneHostTree` only ever renders the ONE active occupant
 * (`WorkspacePaneHostTree.tsx`), so switching the ambient dock away from
 * Chat and back fully unmounts and remounts the Chat occupant — and Chat
 * placing itself again always does so via a FRESH
 * `createWorkspaceChatPaneInstance` (`ambientDockOccupants.ts`,
 * `AmbientChatDockPaneHost.tsx`'s `undockOccupant`), the exact same
 * mechanism the occupant-picker's "Chat" entry uses. A session-derived badge
 * (the pre-fix `dockProjectSlug`) had no way to survive that.
 *
 * These tests mount the REAL `AmbientChatDockPaneHost` (archive#4484's own
 * test pattern — see `DockShellControlParity.test.tsx`'s doc comment on why
 * Chat's own content is stubbed here rather than mounting the full,
 * heavy `ChatWorkspacePane`) and read the binding through the REAL
 * `shellChrome` the host hands to whichever occupant is docked — not a
 * hand-built chrome object. That is the one piece of `ChatWorkspacePane`'s
 * behavior this fix actually changed: it now reads
 * `shellChrome.activeProjectSlug` instead of deriving from the active
 * session, so proving the CHROME's own value survives the real remount
 * mechanics proves the fix, without needing `ChatWorkspacePane`'s (entirely
 * separate, and much larger) session/agent/orchestration data graph.
 */

import {
  createWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import type { AmbientDockShellApi } from '../AmbientChatDockPaneHost';
import { AmbientChatDockPaneHost } from '../AmbientChatDockPaneHost';
import type { WorkspacePaneDockAction } from '../WorkspacePaneDockContext';

vi.mock('../../views/home/useHomeViewModel', () => ({
  useHomeViewModel: () => ({}),
}));
vi.mock('../../views/home/HomeSurface', () => ({
  HomeSurface: () => <p data-testid="ambient-home-occupant">Home surface</p>,
}));
vi.mock('../../views/SessionsView', () => ({
  SessionsView: () => (
    <p data-testid="ambient-activity-occupant">Sessions surface</p>
  ),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));

let projectsForBinding: { slug: string }[] = [
  { slug: 'alpha' },
  { slug: 'beta' },
];
// archive#4525: the deletion-cleanup effect gates on
// `isConfirmedLoaded` (positive evidence of a successful, error-free load),
// never merely `!isLoading` — both the pending shape and the error shape
// settle with `isLoading: false`-or-true combinations that must NOT read as
// "confirmed deleted." Defaults to `true` (a steady state after a real
// load) so this file's deletion test carries an explicit, distinct marker
// from the pending/error shapes.
let projectsConfirmedLoadedForBinding = true;

// A real (non-mocked) `useProjects` needs a QueryClientProvider this
// host-level chrome test has no reason to also stand up — mocked exactly
// like `useDockShellChrome.test.ts`'s own project-deletion-cleanup tests,
// so this file can still exercise that cleanup path deliberately.
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: projectsForBinding,
    isConfirmedLoaded: projectsConfirmedLoadedForBinding,
  }),
}));

const AMBIENT_DOCK_STORAGE_KEY =
  'station:workspace-pane-host:v2:ambient:chat-dock';
const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';

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
  window.localStorage.removeItem(DEVICE_SETTINGS_KEY);
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
  projectsForBinding = [{ slug: 'alpha' }, { slug: 'beta' }];
  projectsConfirmedLoadedForBinding = true;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(AMBIENT_DOCK_STORAGE_KEY);
  window.localStorage.removeItem(DEVICE_SETTINGS_KEY);
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
  delete (globalThis.navigator as { locks?: unknown }).locks;
});

/**
 * Stands in for `ChatWorkspacePane`'s one relevant read/write of the shell
 * chrome: it displays `shellChrome.activeProjectSlug` (what
 * `ChatDock.tsx`'s `dockProjectSlug` now resolves to) and exposes a button
 * that calls `shellChrome.setActiveProjectSlug` (what the project-switcher
 * picker's row now calls, archive#4524's `handleSwitchProject`) — the exact
 * two chrome members this fix added, read through the REAL object the host
 * hands down.
 */
function ChatOccupantStub({
  shellChrome,
}: {
  shellChrome: AmbientDockShellApi;
}) {
  return (
    <div data-testid="ambient-chat-occupant">
      <span data-testid="chat-project-slug">
        {shellChrome.activeProjectSlug ?? 'null'}
      </span>
      <button
        type="button"
        onClick={() => shellChrome.setActiveProjectSlug('alpha')}
      >
        Bind alpha
      </button>
      <button
        type="button"
        onClick={() => shellChrome.setActiveProjectSlug('beta')}
      >
        Bind beta
      </button>
    </div>
  );
}

function renderHost(
  onDockActionChange?: (action: WorkspacePaneDockAction | null) => void,
) {
  return render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <AmbientChatDockPaneHost
          renderChatPane={(_instance, _onRequestAuth, shellChrome) => (
            <ChatOccupantStub shellChrome={shellChrome} />
          )}
          onDockActionChange={onDockActionChange}
        />
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
}

async function dockedAction(): Promise<WorkspacePaneDockAction> {
  const published: (WorkspacePaneDockAction | null)[] = [];
  renderHost((action) => published.push(action));
  await waitFor(() => {
    expect(published.some((action) => action !== null)).toBe(true);
  });
  const latest = [...published].reverse().find((action) => action !== null);
  if (!latest) throw new Error('no dock action published');
  return latest;
}

function boundSlug(): string {
  return screen.getByTestId('chat-project-slug').textContent ?? '';
}

describe('the dock project binding survives an occupant switch (station#4525 Phase 1 trigger #1)', () => {
  test('bind alpha, switch to Home, switch back to Chat via the occupant picker path — binding intact', async () => {
    const action = await dockedAction();
    expect(boundSlug()).toBe('null');

    await act(async () => screen.getByText('Bind alpha').click());
    expect(boundSlug()).toBe('alpha');

    // Switch away: the Chat occupant (and this stub) fully unmounts — this
    // IS the archive#4484 remount boundary the investigation named.
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

    // Switch back to Chat through the SAME `dockPane` replace path the
    // occupant-picker's "Chat" menu entry (and `undockOccupant`) use — a
    // FRESH `createWorkspaceChatPaneInstance`, exactly like production
    // (`ambientDockOccupants.ts`'s `AMBIENT_DOCK_RENDERABLE_PANES` Chat
    // entry).
    act(() => {
      action.dockPane(
        WORKSPACE_CHAT_PANE_DESCRIPTOR,
        createWorkspaceChatPaneInstance()!,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    });

    expect(
      boundSlug(),
      'the binding must survive the real Chat occupant remount, not reset to "No project"',
    ).toBe('alpha');
  });
});

describe('the dock project binding survives a full host remount (station#4525 Phase 1 trigger #3: reconnect/session churn)', () => {
  test('bind alpha, unmount the entire ambient host, remount fresh — binding intact (persisted, not session-derived)', async () => {
    const first = renderHost();
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    });
    await act(async () => screen.getByText('Bind alpha').click());
    expect(boundSlug()).toBe('alpha');

    // A full remount of the ambient host is the closest host-level proxy for
    // a reconnect/session-churn event: every piece of component-local state
    // this fix moved OFF of (activeSessionId, the old session-derived
    // badge) is destroyed and rebuilt from scratch, exactly as it would be
    // by a real reconnect's query invalidation + refetch race
    // (`useQueryCacheReconnectSync.ts`) transiently emptying the active
    // session. The binding is untouched because it was never derived from
    // that state in the first place — it comes back from the persisted
    // device setting.
    first.unmount();
    const second = renderHost();
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    });
    expect(boundSlug()).toBe('alpha');
    second.unmount();
  });
});

describe('only an explicit picker change or project deletion moves the binding (station#4525 acceptance)', () => {
  test('an explicit rebind (the picker path) changes the binding to the newly chosen project', async () => {
    await dockedAction();
    await act(async () => screen.getByText('Bind alpha').click());
    expect(boundSlug()).toBe('alpha');

    await act(async () => screen.getByText('Bind beta').click());
    expect(
      boundSlug(),
      'an explicit rebind must move the binding, unlike every reset trigger above',
    ).toBe('beta');
  });

  test('the bound project being deleted (a CONFIRMED, successful load without it) clears the binding', async () => {
    const action = await dockedAction();
    await act(async () => screen.getByText('Bind alpha').click());
    expect(boundSlug()).toBe('alpha');

    // 'alpha' no longer exists — the production equivalent is the projects
    // query itself refetching and coming back without it. Explicit,
    // distinct from the error shape asserted below: a SUCCESSFUL load
    // (`isConfirmedLoaded: true`) is the only thing this cleanup may act on
    // (archive#4525).
    projectsForBinding = [];
    projectsConfirmedLoadedForBinding = true;
    // Force a fresh render of the persistent `DockShell` instance (its
    // `useProjects` read is a plain function call, not a subscription, so
    // it only re-evaluates on render) — an occupant round-trip is a real,
    // already-proven-safe way to do that without inventing a fake trigger.
    act(() => {
      action.dockPane(
        WORKSPACE_HOME_PANE_DESCRIPTOR,
        WORKSPACE_HOME_PANE_INSTANCE,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
    });
    act(() => {
      action.undockOccupant();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    });
    expect(
      boundSlug(),
      'the cleanup effect must clear a binding whose project is confirmed gone',
    ).toBe('null');
  });

  // archive#4525: the pre-fix guard (`!isLoading`) could not
  // distinguish an errored query from a confirmed-empty one — both settle
  // with `projects` folded to `[]`. Reproduced at the real-host level, not
  // just the hook-unit level (`useDockShellChrome.test.ts`), because this
  // is the exact shape a cold boot or a broken-network window produces in
  // production, and this file is what proves the fix against the real
  // remount/render mechanics.
  test('an errored projects query never clears the binding, even though `projects` reads empty', async () => {
    const action = await dockedAction();
    await act(async () => screen.getByText('Bind alpha').click());
    expect(boundSlug()).toBe('alpha');

    // The error shape: `projects` folded to `[]`, but never confirmed.
    projectsForBinding = [];
    projectsConfirmedLoadedForBinding = false;
    act(() => {
      action.dockPane(
        WORKSPACE_HOME_PANE_DESCRIPTOR,
        WORKSPACE_HOME_PANE_INSTANCE,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-home-occupant')).not.toBeNull();
    });
    act(() => {
      action.undockOccupant();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    });
    expect(
      boundSlug(),
      'an unconfirmed (errored/pending) load must never be read as a deletion',
    ).toBe('alpha');
  });
});
