import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { ToastActionError, toastStore } from '../../contexts/ToastContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';

/**
 * General Undo (#4688): one way to take back a reversible action.
 *
 * An action is offered as a toast with an Undo button, and Mod+Z undoes the
 * most recent one. The destructive write is DEFERRED: `commit` runs only when
 * the toast leaves the screen without Undo (it expired, was closed, or every
 * notification was dismissed). Undo therefore never restores a snapshot; it
 * cancels a write that has not happened, so anything changed elsewhere in the
 * meantime survives it.
 *
 * The toast store pauses expiry while the toast is hovered, focused or the
 * tab is hidden, so the window cannot close under a reader. A Station change
 * drops pending work instead of committing it, because `commit` was captured
 * for the previous Station. Leaving the page before the window closes also
 * commits nothing: the record stays as it was.
 */
export type UndoableAction = {
  /** Stable identity of the affected record, e.g. `board:<slug>`. */
  key: string;
  /** What happened, as the toast says it. */
  message: string;
  /** Announced after Undo, e.g. `Restored Daily brief`. */
  restoredMessage: string;
  /** The deferred write. A rejection is shown with `failureMessage`. */
  commit: () => Promise<unknown>;
  /** Shown, with the error's own words when it has some, if `commit` fails. */
  failureMessage: string;
  /** Local follow-up after Undo, such as returning to the restored page. */
  onUndo?: () => void;
  /**
   * Why Undo can no longer restore this, or null while it can. The reason is
   * shown on the toast rather than silently doing nothing.
   */
  undoUnavailableReason?: () => string | null;
  /** Whether the authority the write was captured for is still current. */
  isCurrent?: () => boolean;
};

type Entry = UndoableAction & {
  state: 'pending' | 'committing' | 'undone' | 'dropped';
  toastId: string;
  offeredAt: number;
};

/** Long enough to reach for, short enough that a delete still feels done. */
export const UNDO_WINDOW_MS = 12000;

let entries: Entry[] = [];
let version = 0;
let sequence = 0;
const listeners = new Set<() => void>();

function publish() {
  version += 1;
  for (const listener of listeners) listener();
}

function remove(entry: Entry) {
  entries = entries.filter((candidate) => candidate !== entry);
  publish();
}

function errorText(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : undefined;
}

function settle(entry: Entry, reason: 'closed' | 'scope') {
  if (entry.state !== 'pending') return;
  if (reason === 'scope' || (entry.isCurrent && !entry.isCurrent())) {
    entry.state = 'dropped';
    remove(entry);
    return;
  }
  entry.state = 'committing';
  publish();
  let pending: Promise<unknown>;
  try {
    pending = entry.commit();
  } catch (error) {
    pending = Promise.reject(error);
  }
  void Promise.resolve(pending).then(
    () => remove(entry),
    (error: unknown) => {
      remove(entry);
      toastStore.upsert({
        message: entry.failureMessage,
        detail: errorText(error),
        tone: 'error',
        duration: 0,
      });
    },
  );
}

function undo(entry: Entry) {
  if (entry.state !== 'pending') {
    throw new ToastActionError('This change has already been saved.');
  }
  const unavailable = entry.undoUnavailableReason?.();
  if (unavailable) throw new ToastActionError(unavailable);
  entry.state = 'undone';
  remove(entry);
  entry.onUndo?.();
  toastStore.upsert({
    message: entry.restoredMessage,
    tone: 'success',
    duration: 4000,
  });
}

/**
 * Offers `action` with Undo. Offering the same `key` again while it is
 * pending replaces the earlier offer and commits it first.
 */
export function offerUndoableAction(action: UndoableAction): void {
  const previous = entries.find(
    (entry) => entry.key === action.key && entry.state === 'pending',
  );
  if (previous) toastStore.dismiss(previous.toastId);
  sequence += 1;
  const entry: Entry = {
    ...action,
    state: 'pending',
    toastId: `undoable-${sequence}`,
    offeredAt: sequence,
  };
  entries = [...entries, entry];
  publish();
  toastStore.upsert({
    id: entry.toastId,
    message: action.message,
    tone: 'info',
    duration: UNDO_WINDOW_MS,
    actions: [{ label: 'Undo', onClick: () => undo(entry) }],
    onDismiss: (reason) => settle(entry, reason),
  });
}

/**
 * Undoes the most recent pending action through its toast, so a refusal is
 * shown in the same place as a click's. False when nothing is pending.
 */
export function undoLatestAction(): boolean {
  const latest = [...entries]
    .reverse()
    .find((entry) => entry.state === 'pending');
  if (!latest) return false;
  toastStore.runAction(latest.toastId, 0);
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keys whose write is pending or in flight; their records read as gone. */
export function pendingUndoKeys(): ReadonlySet<string> {
  return new Set(
    entries
      .filter(
        (entry) => entry.state === 'pending' || entry.state === 'committing',
      )
      .map((entry) => entry.key),
  );
}

/** Subscribes to `pendingUndoKeys` for a surface that hides those records. */
export function usePendingUndoKeys(): ReadonlySet<string> {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return pendingUndoKeys();
}

/** Test seam: forgets every offer without committing it. */
export function resetUndoableActionsForTest() {
  entries = [];
  publish();
}

/**
 * Registers Mod+Z for the most recent undoable action. Inside a text field,
 * editor or terminal the registry leaves Mod+Z to that field (#4383), so its
 * own Undo always wins.
 */
export function UndoableActionShortcut({ children }: { children: ReactNode }) {
  useKeyboardShortcut(
    'app.undoLastAction',
    'z',
    ['cmd'],
    'Undo last action',
    () => (undoLatestAction() ? undefined : false),
  );
  return children;
}
