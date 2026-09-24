import {
  type RefObject,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

/**
 * Which live sources a pane is showing right now (#90 D9), so the
 * float-over-chat can hide while the SAME source is on screen in a pane.
 *
 * The pane announces it, rather than the floater inferring it from a region
 * arrangement: a Browser pane can be a dock tab, a project Layout's panel or
 * a Coding layout's, and only the pane knows it rendered the live view. It
 * announces only while its live view is on screen (an IntersectionObserver
 * on the element it passes), so a pane behind another tab or scrolled away
 * does not hide the floater and leave the source shown nowhere.
 *
 * Hiding is also the ADR 0018 connection budget: a hidden floater unmounts
 * its canvas, so one source never streams to the pane and the floater at
 * once.
 *
 * A module store rather than a context: panes and the floater mount under
 * different providers (a region host, a Layout, the chat dock), and a count
 * per key lets two panes showing one source both hold it.
 */

const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

/** Mark `key` shown until the returned release is called. */
export function announceShownSource(key: string): () => void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (counts.get(key) ?? 1) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
    emit();
  };
}

export function isSourceShown(key: string): boolean {
  return (counts.get(key) ?? 0) > 0;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a pane is showing `key` now; false for no key. */
export function useSourceShown(key: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? false : isSourceShown(key)),
    () => false,
  );
}

/** Changes whenever any source becomes shown or stops being shown. */
export function useShownSourcesVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/**
 * A pane's announcement: `key` is shown while `ref`'s element is on screen.
 * Where there is no IntersectionObserver (a test environment, an old
 * webview) a mounted view counts as shown, which errs toward hiding the
 * floater rather than streaming one source twice.
 */
export function useAnnounceShownSource(
  key: string | null,
  ref: RefObject<Element | null>,
): void {
  const [onScreen, setOnScreen] = useState(true);
  // Re-observed when the key changes: a pane renders its live view (and so
  // the observed element) only once it has a source to show.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the change signal for the element behind ref.
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, key]);
  useEffect(() => {
    if (key === null || !onScreen) return;
    return announceShownSource(key);
  }, [key, onScreen]);
}
