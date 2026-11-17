import { act } from '@testing-library/react';

/**
 * Lets every history traversal already queued land. jsdom runs `history.back()`
 * as two chained 0ms tasks (the delta is resolved in the first, the entry
 * applied in the second), so each yield below is a task turn, not a wait for
 * time to pass; four covers a traversal started by the traversal's own
 * popstate handler as well.
 *
 * A suite that unmounts a dialog-history layer in its teardown must call this
 * before anything pushes history again. Unmounting folds the layer by
 * travelling back, and the dialog-history module holds its next layer
 * unpublished until that Back's popstate lands. jsdom, unlike a browser,
 * cancels a queued traversal on the next `pushState`, so a push from the next
 * test's setup strands that wait for the rest of the file: no later layer is
 * ever published, and every case that expects one times out.
 */
export async function flushHistoryTraversals(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
}
