/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { navigationStore } from '../contexts/navigation-store';

/**
 * `lastDockMaximized` exists so a mobile round trip through a closed dock
 * (e.g. following a delegated task into another surface and back via the task
 * switcher) can restore the dock's maximize preference even though a closed
 * dock's `maximize` URL param is always cleared by design (archive#795 — see
 * the field doc on `NavigationStore`). These tests drive the real singleton
 * through `window.history`, the same surface production code uses.
 */
describe('navigationStore dock maximize memory', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    // Re-sync the singleton's parsed state (and lastDockMaximized) with the
    // URL reset above — production code never needs this because every
    // mutation routes through the store itself, but the singleton persists
    // across this file's tests.
    navigationStore.navigate('/', { dock: null, maximize: null });
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  test('a direct ?maximize=true load is remembered without any setDockState call', () => {
    window.history.replaceState({}, '', '/?dock=open&maximize=true');
    navigationStore.navigate('/', {});
    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  test('setDockState(false, isDockMaximized) clears the URL flag but keeps the memory', () => {
    navigationStore.setDockState(true, true);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);

    navigationStore.setDockState(
      false,
      navigationStore.getSnapshot().isDockMaximized,
    );
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  test('an explicit non-maximized open clears the memory', () => {
    navigationStore.setDockState(true, true);
    expect(navigationStore.lastDockMaximized).toBe(true);

    navigationStore.setDockState(true, false);
    expect(navigationStore.lastDockMaximized).toBe(false);
  });

  // archive#945 (review of the original fix): a closed-but-still-maximized URL
  // is NOT safe on mobile either — index.css's `@media (max-width: 768px)`
  // `.chat-dock.is-maximized` rule matches on `is-maximized` alone (it does
  // not exclude `is-collapsed`) and sets `height` with `!important`, which
  // beats the dock's plain inline height guard. A closed dock carrying
  // `maximize=true` therefore still renders the archive#795 blank full-height shell
  // on mobile, with its body omitted because `isDockOpen` is false. The
  // task switcher's `onOpenSession` (`ChatDock.tsx`) must always go through
  // `setDockState` to close — never leave `maximize` in the URL directly —
  // and rely on `lastDockMaximized` (not the URL) for the later restore.
  test('the mobile task-switcher navigation sequence never leaves dock closed + maximize=true in the URL', () => {
    // Mirrors ChatDock's onOpenSession handler exactly: setDockState(false,
    // isDockMaximized) to close (honoring the archive#795 invariant), then navigate
    // to the session route.
    navigationStore.setDockState(true, true);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);

    navigationStore.setDockState(
      false,
      navigationStore.getSnapshot().isDockMaximized,
    );
    // The unsafe combination must never be observable, not even transiently
    // between the close and the navigate.
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);

    navigationStore.navigate('/agents', { session: 'task-1' });

    const afterNavigate = navigationStore.getSnapshot();
    expect(afterNavigate.isDockOpen).toBe(false);
    // The invariant: a closed dock never carries maximize=true in the URL.
    expect(afterNavigate.isDockMaximized).toBe(false);
    // The preference is not lost — it survives in memory for the restore.
    expect(navigationStore.lastDockMaximized).toBe(true);
  });

  // archive#1284 (MED): useChatDockActiveChatSync's cold-path fallback
  // navigated away with { chat: null, dock: null, session: <id> }
  // specifically because navigate otherwise PRESERVES every unlisted param --
  // a dock-targeting deep link (archive#1284) already stamps dock=open on the
  // URL the dead pointer came from, so omitting dock: null would land on
  // <destination>?dock=open and force the dock open and empty on a page with
  // nothing to show in it. The destination is incidental here (#928 retired
  // the /activity route the fallback used to name); what is asserted is the
  // param hygiene across any route change.
  test('the cold-path-fallback navigate call clears dock=open inherited from the dead deep link', () => {
    window.history.replaceState(
      {},
      '',
      '/projects/proj-a?chat=dead-thread&dock=open',
    );
    navigationStore.navigate('/', {});
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);

    navigationStore.navigate('/agents', {
      chat: null,
      dock: null,
      session: 'dead-thread',
    });

    const after = navigationStore.getSnapshot();
    expect(after.isDockOpen).toBe(false);
    expect(after.activeChat).toBeNull();
    expect(window.location.search).not.toContain('dock=open');
  });

  test('focusSession-style restore (setDockState(true, lastDockMaximized)) reinstates the URL flag after the round trip', () => {
    navigationStore.setDockState(true, true);
    navigationStore.setDockState(
      false,
      navigationStore.getSnapshot().isDockMaximized,
    );
    navigationStore.navigate('/agents', { session: 'task-1' });
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);

    // What `focusSession` (useChatDockActions.ts) does on return.
    navigationStore.navigate('/', { session: null, chat: 'conv-1' });
    navigationStore.setDockState(true, navigationStore.lastDockMaximized);

    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
  });

  // archive#1298 (archive#1312): ChatDock's archive#1298 collapse-on-navigate
  // seams (an inbox row falling back to another surface, the project-context
  // badge, a delegation toast) keep the dock OPEN the whole time — there is
  // no close-then-reopen round trip for `setDockState(open, false)`'s
  // `lastDockMaximized` clobber to survive. `collapseMaximizedDock` is the
  // primitive those seams use instead: it must clear the effective
  // `maximize` flag (so the dock visibly un-maximizes) WITHOUT touching
  // `lastDockMaximized`, or a later `focusSession`-style restore would
  // permanently read `false` after the very first collapse-on-navigate.
  describe('collapseMaximizedDock (#1298 collapse-on-navigate seams)', () => {
    test('clears the effective maximize flag while the dock stays open', () => {
      navigationStore.setDockState(true, true);
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);

      navigationStore.collapseMaximizedDock();

      expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
    });

    test('does NOT clobber lastDockMaximized, unlike setDockState(isDockOpen, false)', () => {
      navigationStore.setDockState(true, true);
      expect(navigationStore.lastDockMaximized).toBe(true);

      navigationStore.collapseMaximizedDock();

      expect(navigationStore.lastDockMaximized).toBe(true);
    });

    test('a later focusSession-style restore still returns to Full after a collapse-on-navigate', () => {
      navigationStore.setDockState(true, true);
      navigationStore.collapseMaximizedDock();
      navigationStore.navigate('/agents', { session: 'task-1' });
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);

      // What `focusSession` (useChatDockActions.ts) does when the user
      // re-engages a chat tab after the collapse.
      navigationStore.setDockState(true, navigationStore.lastDockMaximized);

      expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
    });

    test('repeated collapse-on-navigate calls (multiple dock-owned seams in a row) never clear the memory', () => {
      navigationStore.setDockState(true, true);

      navigationStore.collapseMaximizedDock();
      navigationStore.collapseMaximizedDock();
      navigationStore.collapseMaximizedDock();

      expect(navigationStore.lastDockMaximized).toBe(true);
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
    });
  });

  // station#1613: `useChatDockActiveChatSync`'s `clearDeadChatPointer` closes
  // the dock with a direct `updateParams({ chat: null, dock: null })`, not via
  // `setDockState`. On a reload of a maximized chat whose session was never
  // persisted that left `maximize=true` beside a closed dock — the exact pair
  // archive#795 refuses. The invariant now sits in `updateParams`, where every
  // writer passes, so this block drives `updateParams` directly.
  describe('updateParams applies the closed-dock invariant (#1613)', () => {
    test('a dock: null write from an open+maximized dock clears maximize from the URL and keeps the memory', () => {
      navigationStore.setDockState(true, true);
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
      expect(navigationStore.lastDockMaximized).toBe(true);

      navigationStore.updateParams({ chat: null, dock: null });

      const after = navigationStore.getSnapshot();
      expect(after.isDockOpen).toBe(false);
      expect(after.isDockMaximized).toBe(false);
      expect(new URLSearchParams(window.location.search).has('maximize')).toBe(
        false,
      );
      expect(navigationStore.lastDockMaximized).toBe(true);
    });

    test('the #1613 reload shape (?chat=<never-persisted>&dock=open&maximize=true) closes to a plain closed dock', () => {
      // A direct load, not a setDockState call: the memory is set by
      // commitState's parse, the same way production reaches this state.
      window.history.replaceState(
        {},
        '',
        '/?chat=never-persisted&dock=open&maximize=true',
      );
      navigationStore.navigate('/', {});
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);

      // Exactly what clearDeadChatPointer writes.
      navigationStore.updateParams({ chat: null, dock: null });

      const after = navigationStore.getSnapshot();
      expect(after.activeChat).toBeNull();
      expect(after.isDockOpen).toBe(false);
      expect(after.isDockMaximized).toBe(false);
      expect(window.location.search).not.toContain('maximize');
      expect(navigationStore.lastDockMaximized).toBe(true);
    });

    test('a dock: "open" write does not clear maximize', () => {
      navigationStore.setDockState(true, true);

      navigationStore.updateParams({ dock: 'open' });

      expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
      expect(new URLSearchParams(window.location.search).get('maximize')).toBe(
        'true',
      );
    });

    test('an unrelated param write does not clear maximize', () => {
      navigationStore.setDockState(true, true);

      navigationStore.updateParams({ fontSize: '16' });

      expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
      expect(new URLSearchParams(window.location.search).get('maximize')).toBe(
        'true',
      );
      expect(new URLSearchParams(window.location.search).get('fontSize')).toBe(
        '16',
      );
    });

    test('a clearDeadChatPointer-shaped write leaves params it did not name alone', () => {
      window.history.replaceState(
        {},
        '',
        '/?chat=dead&dock=open&maximize=true&fontSize=16&conversation=conv-1',
      );
      navigationStore.navigate('/', {});

      navigationStore.updateParams({ chat: null, dock: null });

      const search = new URLSearchParams(window.location.search);
      expect(search.has('chat')).toBe(false);
      expect(search.has('dock')).toBe(false);
      expect(search.has('maximize')).toBe(false);
      expect(search.get('fontSize')).toBe('16');
      expect(search.get('conversation')).toBe('conv-1');
      expect(navigationStore.getSnapshot().activeConversation).toBe('conv-1');
      expect(navigationStore.getSnapshot().fontSize).toBe(16);
    });
  });
});
