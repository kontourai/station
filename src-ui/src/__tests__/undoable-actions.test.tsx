/** @vitest-environment jsdom */
/**
 * #4688 — the General Undo primitive, driven through the real toast card and
 * the real shortcut registry. The deferred write is a spy standing in for the
 * server, so "committed" and "never committed" are observations of the write
 * itself, not of local state.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NotificationContainer } from '../components/notifications/NotificationContainer';
import {
  offerUndoableAction,
  pendingUndoKeys,
  resetUndoableActionsForTest,
  UNDO_WINDOW_MS,
  type UndoableAction,
  UndoableActionShortcut,
} from '../components/undo/undoable-actions';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { ToastProvider, toastStore } from '../contexts/ToastContext';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatIds: () => [],
}));

class VisibleObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds = [0, 0.95, 1];
  takeRecords() {
    return [];
  }
  unobserve() {}
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
        } as IntersectionObserverEntry,
      ],
      this,
    );
  }
  disconnect() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', VisibleObserver);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  resetUndoableActionsForTest();
  toastStore.dismissAll();
  toastStore.clearHistory();
  localStorage.clear();
  toastStore.bindScope('station-a');
});
afterEach(() => {
  cleanup();
  resetUndoableActionsForTest();
  toastStore.dismissAll();
  toastStore.clearHistory();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(
    <ToastProvider stationScope="station-a">
      <KeyboardShortcutsProvider>
        <UndoableActionShortcut>
          <input aria-label="Notes" />
          <button type="button">Elsewhere</button>
        </UndoableActionShortcut>
      </KeyboardShortcutsProvider>
      <NotificationContainer />
    </ToastProvider>,
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function offer(overrides: Partial<UndoableAction> = {}) {
  const commit = vi.fn(async () => undefined);
  const onUndo = vi.fn();
  act(() =>
    offerUndoableAction({
      key: 'record:a',
      message: 'Deleted Alpha',
      restoredMessage: 'Restored Alpha',
      failureMessage: 'Could not delete Alpha.',
      commit,
      onUndo,
      ...overrides,
    }),
  );
  return { commit, onUndo };
}

test('the write waits for the window, then commits once when it expires', async () => {
  mount();
  const { commit } = offer();
  expect(screen.getByText('Deleted Alpha')).toBeTruthy();
  expect(pendingUndoKeys().has('record:a')).toBe(true);
  advance(UNDO_WINDOW_MS - 1);
  expect(commit).not.toHaveBeenCalled();
  advance(1);
  await flush();
  expect(commit).toHaveBeenCalledTimes(1);
  expect(pendingUndoKeys().has('record:a')).toBe(false);
  expect(screen.queryByText('Deleted Alpha')).toBeNull();
});

test('Undo cancels the write, restores the record and announces it', async () => {
  mount();
  const { commit, onUndo } = offer();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(onUndo).toHaveBeenCalledTimes(1);
  expect(pendingUndoKeys().has('record:a')).toBe(false);
  // The container is the polite live region the restore is announced in.
  const live = document.querySelector('[aria-live="polite"]');
  expect(live?.textContent).toContain('Restored Alpha');
  advance(UNDO_WINDOW_MS * 3);
  await flush();
  expect(commit).not.toHaveBeenCalled();
});

test('closing the notice commits rather than discarding the action', async () => {
  mount();
  const { commit } = offer();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
  await flush();
  expect(commit).toHaveBeenCalledTimes(1);
});

test('hover and focus hold the window open (WCAG 2.2.1)', async () => {
  mount();
  const { commit } = offer();
  const card = screen.getByTestId('toast-card');
  fireEvent.mouseEnter(card);
  advance(UNDO_WINDOW_MS * 5);
  expect(commit).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  fireEvent.mouseLeave(card);
  act(() => screen.getByRole('button', { name: 'Undo' }).focus());
  advance(UNDO_WINDOW_MS * 5);
  expect(commit).not.toHaveBeenCalled();
  act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
  advance(UNDO_WINDOW_MS);
  await flush();
  expect(commit).toHaveBeenCalledTimes(1);
});

test('an Undo that is no longer valid says why and leaves the write pending', async () => {
  mount();
  const { commit, onUndo } = offer({
    undoUnavailableReason: () => 'Alpha was changed on another device.',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByRole('alert').textContent).toBe(
    'Alpha was changed on another device.',
  );
  expect(onUndo).not.toHaveBeenCalled();
  expect(pendingUndoKeys().has('record:a')).toBe(true);
  expect(commit).not.toHaveBeenCalled();
});

test('a failed write is shown and the record is released back', async () => {
  mount();
  offer({
    commit: vi.fn(async () => {
      throw new Error('Board storage is unavailable');
    }),
  });
  advance(UNDO_WINDOW_MS);
  await flush();
  expect(pendingUndoKeys().has('record:a')).toBe(false);
  expect(screen.getByText('Could not delete Alpha.')).toBeTruthy();
  // Error toasts do not expire on their own.
  advance(UNDO_WINDOW_MS * 5);
  expect(screen.getByText('Could not delete Alpha.')).toBeTruthy();
});

test('a Station change drops the pending write instead of sending it there', async () => {
  mount();
  const { commit } = offer();
  act(() => toastStore.bindScope('station-b'));
  advance(UNDO_WINDOW_MS * 2);
  await flush();
  expect(commit).not.toHaveBeenCalled();
  expect(pendingUndoKeys().has('record:a')).toBe(false);
});

test('an authority that is no longer current drops the write', async () => {
  mount();
  const { commit } = offer({ isCurrent: () => false });
  advance(UNDO_WINDOW_MS);
  await flush();
  expect(commit).not.toHaveBeenCalled();
});

test('Mod+Z undoes the most recent action, but never inside a text field', async () => {
  mount();
  const first = offer({ key: 'record:a' });
  const second = offer({ key: 'record:b', message: 'Deleted Beta' });
  const input = screen.getByRole('textbox', { name: 'Notes' });
  act(() => input.focus());
  const inField = fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
  // Not prevented: the field keeps its own native Undo.
  expect(inField).toBe(true);
  expect(second.onUndo).not.toHaveBeenCalled();
  expect(pendingUndoKeys().size).toBe(2);

  act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(second.onUndo).toHaveBeenCalledTimes(1);
  expect(first.onUndo).not.toHaveBeenCalled();
  expect([...pendingUndoKeys()]).toEqual(['record:a']);

  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(first.onUndo).toHaveBeenCalledTimes(1);
  advance(UNDO_WINDOW_MS * 2);
  await flush();
  expect(first.commit).not.toHaveBeenCalled();
  expect(second.commit).not.toHaveBeenCalled();
});

test('Mod+Z with nothing to undo is left to the browser', () => {
  mount();
  act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
  expect(fireEvent.keyDown(window, { key: 'z', ctrlKey: true })).toBe(true);
});
