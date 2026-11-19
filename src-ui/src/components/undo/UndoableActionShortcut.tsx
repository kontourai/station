import type { ReactNode } from 'react';
import { toastStore } from '../../contexts/ToastContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';

/**
 * The always-mounted half of General Undo (#4688): the Mod+Z command and the
 * notices it can reach. It stays this small because it ships in the entry
 * bundle; offering, committing and restoring live in `undoable-actions.tsx`,
 * which loads with the surfaces that offer an undoable action.
 */
let pendingUndoNotices: string[] = [];

/** Records a notice whose Undo is still available, newest last. */
export function trackPendingUndo(toastId: string) {
  pendingUndoNotices = [...pendingUndoNotices, toastId];
}

/** Forgets a notice once its action was undone, committed or dropped. */
export function untrackPendingUndo(toastId: string) {
  pendingUndoNotices = pendingUndoNotices.filter((id) => id !== toastId);
}

/** Test seam: forgets every tracked notice. */
export function resetPendingUndoForTest() {
  pendingUndoNotices = [];
}

/**
 * Undoes the most recent pending action through its notice, so a refusal is
 * shown in the same place as a click's. False when nothing is pending.
 */
export function undoLatestAction(): boolean {
  const latest = pendingUndoNotices.at(-1);
  if (!latest) return false;
  toastStore.runAction(latest, 0);
  return true;
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
