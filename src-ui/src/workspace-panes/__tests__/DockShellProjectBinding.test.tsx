/** @vitest-environment jsdom */

/**
 * archive#4525: the dock's project binding is DockShell-owned state
 * (`useDockShellChrome`'s `activeProjectSlug`/`setActiveProjectSlug`), not a
 * derivation of whichever chat session happens to be active. A
 * session-derived badge (the pre-fix `dockProjectSlug`) reset to "No
 * project" on every remount of the docked Chat content — the Phase-1
 * investigation found three triggers: an occupant switch (gone with #928
 * C2b: Chat is the only pane the dock hosts), a directly-created new chat
 * with no project, and reconnect/session churn. The fix moved the binding
 * onto the persistent shell, where the content's remounts cannot reach it.
 *
 * These tests mount the REAL `DockShell` (the same component
 * `AmbientChatDockPaneHost` wraps Chat in) and read the binding through the
 * REAL `DockShellChrome` it hands its render prop — not a hand-built chrome
 * object. Chat's own content is stubbed (see `DockShellControlParity.test.tsx`
 * on why the full, heavy `ChatWorkspacePane` is not mounted here): the one
 * piece of `ChatWorkspacePane`'s behavior the fix changed is that it reads
 * `shellChrome.activeProjectSlug` instead of deriving from the active
 * session, so proving the CHROME's own value survives the remount mechanics
 * proves the fix without `ChatWorkspacePane`'s data graph.
 *
 * Until #928 C2b this file was `AmbientChatDockProjectBinding.test.tsx` and
 * drove the binding through the ambient host's occupant switch; the property
 * it proves is unchanged, the driver is now the shell itself.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DockShell } from '../../components/chat-dock/DockShell';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import type { DockShellChrome } from '../../hooks/useDockShellChrome';

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
// shell-level chrome test has no reason to also stand up — mocked exactly
// like `useDockShellChrome.test.ts`'s own project-deletion-cleanup tests,
// so this file can still exercise that cleanup path deliberately.
vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: projectsForBinding,
    isConfirmedLoaded: projectsConfirmedLoadedForBinding,
  }),
}));

const DEVICE_SETTINGS_KEY = 'station-device-settings-v1';

beforeEach(() => {
  window.localStorage.removeItem(DEVICE_SETTINGS_KEY);
  window.history.replaceState({}, '', '/?dock=open');
  navigationStore.navigate('/', { dock: 'open', maximize: null });
  projectsForBinding = [{ slug: 'alpha' }, { slug: 'beta' }];
  projectsConfirmedLoadedForBinding = true;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(DEVICE_SETTINGS_KEY);
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', { dock: null, maximize: null });
});

/**
 * Stands in for `ChatWorkspacePane`'s one relevant read/write of the shell
 * chrome: it displays `shellChrome.activeProjectSlug` (what
 * `ChatDock.tsx`'s `dockProjectSlug` resolves to) and exposes a button
 * that calls `shellChrome.setActiveProjectSlug` (what the project-switcher
 * picker's row calls, archive#4524's `handleSwitchProject`) — the exact
 * two chrome members this fix added, read through the REAL object the shell
 * hands down.
 */
function ChatOccupantStub({ shellChrome }: { shellChrome: DockShellChrome }) {
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

function shellTree() {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <DockShell>
          {(shellChrome) => <ChatOccupantStub shellChrome={shellChrome} />}
        </DockShell>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

function renderShell() {
  const rendered = render(shellTree());
  return {
    ...rendered,
    // A fresh render of the SAME tree (new element, same component
    // instances): the persistent `DockShell` re-evaluates its `useProjects`
    // read without unmounting, which is exactly what a projects refetch
    // does to it in production.
    rerenderShell: () => rendered.rerender(shellTree()),
  };
}

function boundSlug(): string {
  return screen.getByTestId('chat-project-slug').textContent ?? '';
}

describe('the dock project binding survives a full shell remount (station#4525 Phase 1 trigger #3: reconnect/session churn)', () => {
  test('bind alpha, unmount the entire shell, remount fresh — binding intact (persisted, not session-derived)', async () => {
    const first = renderShell();
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    });
    await act(async () => screen.getByText('Bind alpha').click());
    expect(boundSlug()).toBe('alpha');

    // A full remount of the shell is the closest shell-level proxy for a
    // reconnect/session-churn event: every piece of component-local state
    // this fix moved OFF of (activeSessionId, the old session-derived
    // badge) is destroyed and rebuilt from scratch, exactly as it would be
    // by a real reconnect's query invalidation + refetch race
    // (`useQueryCacheReconnectSync.ts`) transiently emptying the active
    // session. The binding is untouched because it was never derived from
    // that state in the first place — it comes back from the persisted
    // device setting.
    first.unmount();
    const second = renderShell();
    await waitFor(() => {
      expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    });
    expect(boundSlug()).toBe('alpha');
    second.unmount();
  });
});

describe('only an explicit picker change or project deletion moves the binding (station#4525 acceptance)', () => {
  test('an explicit rebind (the picker path) changes the binding to the newly chosen project', async () => {
    renderShell();
    await act(async () => screen.getByText('Bind alpha').click());
    expect(boundSlug()).toBe('alpha');

    await act(async () => screen.getByText('Bind beta').click());
    expect(
      boundSlug(),
      'an explicit rebind must move the binding, unlike every reset trigger above',
    ).toBe('beta');
  });

  test('the bound project being deleted (a CONFIRMED, successful load without it) clears the binding', async () => {
    const { rerenderShell } = renderShell();
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
    // it only re-evaluates on render).
    act(() => rerenderShell());
    await waitFor(() => {
      expect(
        boundSlug(),
        'the cleanup effect must clear a binding whose project is confirmed gone',
      ).toBe('null');
    });
  });

  // archive#4525: the pre-fix guard (`!isLoading`) could not
  // distinguish an errored query from a confirmed-empty one — both settle
  // with `projects` folded to `[]`. Reproduced at the real-shell level, not
  // just the hook-unit level (`useDockShellChrome.test.ts`), because this
  // is the exact shape a cold boot or a broken-network window produces in
  // production, and this file is what proves the fix against the real
  // remount/render mechanics.
  test('an errored projects query never clears the binding, even though `projects` reads empty', async () => {
    const { rerenderShell } = renderShell();
    await act(async () => screen.getByText('Bind alpha').click());
    expect(boundSlug()).toBe('alpha');

    // The error shape: `projects` folded to `[]`, but never confirmed.
    projectsForBinding = [];
    projectsConfirmedLoadedForBinding = false;
    act(() => rerenderShell());
    await act(async () => undefined);
    expect(screen.queryByTestId('ambient-chat-occupant')).not.toBeNull();
    expect(
      boundSlug(),
      'an unconfirmed (errored/pending) load must never be read as a deletion',
    ).toBe('alpha');
  });
});
