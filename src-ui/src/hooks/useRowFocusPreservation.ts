import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Keeps keyboard focus on a work row when a SERVER-driven change moves it to
 * another lane (Running -> Idle, Needs you -> Running, ...).
 *
 * Lanes are separate sections, so a row that changes lane is unmounted from
 * one and mounted in the other. Without this, the focused element is simply
 * removed and focus falls to `<body>` — a keyboard or screen-reader user
 * loses their place because the agent finished a turn. User-driven removals
 * (snooze, close, discard) already move focus first
 * (`moveFocusBeforeRemovingInboxRow`); this covers the moves nobody asked
 * for.
 *
 * Rows opt in with `data-row-key` (their stable identity) on the row root.
 * After each commit, if the last focused element inside `root` has been
 * disconnected and focus is now on `<body>`, focus goes to the same key's
 * `focusTargetSelector` in its new place. If the row is gone entirely, the
 * row that followed it (by the last observed order), then the one before
 * it, then `root` itself (which must be focusable, e.g. `tabIndex={-1}`).
 *
 * Deliberately inert when focus left the rows on purpose. Focusing anything
 * that is not a row inside `root` clears the record, and so does a blur to
 * nowhere (`focusout` with no `relatedTarget`, e.g. clicking empty space)
 * whose element is still connected, and no longer focused, afterwards (a
 * window or tab switch fires the same event but leaves the element focused). That connectedness check is
 * what separates a deliberate blur from a removal: some engines fire
 * `focusout` on removal and some (Chrome) fire nothing, so the decision is
 * deferred to a microtask — after React's commit and this hook's restore —
 * and only a still-connected element counts as the user leaving.
 *
 * A candidate that cannot take focus (e.g. inside a closed `<details>`) is
 * skipped: focus is confirmed with `document.activeElement` before moving
 * on to the next candidate and finally `root`.
 */
export function useRowFocusPreservation(
  rootRef: RefObject<HTMLElement | null>,
  focusTargetSelector: string,
): void {
  const lastRef = useRef<{
    key: string;
    element: HTMLElement;
    order: string[];
  } | null>(null);

  // Listening on `document` (not the root) so a host whose root mounts later
  // (an opened sheet) is covered without re-subscribing.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const root = rootRef.current;
      const target = event.target as HTMLElement | null;
      const row = target?.closest<HTMLElement>('[data-row-key]');
      if (!root || !target || !row || !root.contains(row)) {
        lastRef.current = null;
        return;
      }
      lastRef.current = {
        key: row.dataset.rowKey ?? '',
        element: target,
        order: rowKeys(root),
      };
    };
    const onFocusOut = (event: FocusEvent) => {
      const root = rootRef.current;
      const next = event.relatedTarget as Node | null;
      if (next && root?.contains(next)) return;
      const left = event.target as HTMLElement | null;
      if (next) {
        lastRef.current = null;
        return;
      }
      queueMicrotask(() => {
        // Still connected AND no longer focused = the user left. A window or
        // tab switch also fires focusout with no relatedTarget, but the
        // element stays document.activeElement; keep the record for it.
        if (
          left?.isConnected &&
          document.activeElement !== left &&
          lastRef.current?.element === left
        ) {
          lastRef.current = null;
        }
      });
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [rootRef]);

  // Every commit: cheap (one isConnected read) unless focus was just lost.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const last = lastRef.current;
    if (!root || !last || last.element.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    for (const target of candidateTargets(root, last, focusTargetSelector)) {
      target.focus();
      if (document.activeElement === target) return;
    }
    lastRef.current = null;
    root.focus();
  });
}

function rowKeys(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-row-key]')).map(
    (row) => row.dataset.rowKey ?? '',
  );
}

function focusTargetIn(
  root: HTMLElement,
  key: string,
  selector: string,
): HTMLElement | null {
  for (const row of root.querySelectorAll<HTMLElement>('[data-row-key]')) {
    if (row.dataset.rowKey === key) {
      return row.querySelector<HTMLElement>(selector);
    }
  }
  return null;
}

function candidateTargets(
  root: HTMLElement,
  last: { key: string; order: string[] },
  selector: string,
): HTMLElement[] {
  const index = last.order.indexOf(last.key);
  const keys = [
    last.key,
    ...last.order.slice(index + 1),
    ...last.order.slice(0, Math.max(index, 0)).reverse(),
  ];
  const targets: HTMLElement[] = [];
  for (const key of keys) {
    const target = focusTargetIn(root, key, selector);
    if (target) targets.push(target);
  }
  return targets;
}
