import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { navigationStore } from '../contexts/navigation-store';

/**
 * Reusable unsaved-changes guard.
 * Provides beforeunload protection + in-app ConfirmModal.
 *
 * Usage:
 *   const { guard, DiscardModal } = useUnsavedGuard(dirty);
 *   function handleSelect(id) { guard( => doSelect(id)); }
 *   return <>{view}<DiscardModal /></>;
 */
export function useUnsavedGuard(dirty: boolean) {
  const [showDiscard, setShowDiscard] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);
  const pendingCancel = useRef<(() => void) | undefined>(undefined);
  const navigationGuardId = useRef(Symbol('unsaved-navigation-guard'));

  useEffect(() => {
    if (dirty || !showDiscard) return;
    setShowDiscard(false);
    pendingRef.current = null;
    pendingCancel.current?.();
    pendingCancel.current = undefined;
  }, [dirty, showDiscard]);

  // Browser close / reload
  // A completed save makes the form visibly clean in the same commit. Keep the
  // browser-leave guard in lockstep: a passive-effect cleanup can otherwise
  // leave a stale beforeunload listener briefly active after that commit.
  useLayoutEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const guard = useCallback(
    (cb: () => void, cancelled?: () => void) => {
      if (dirty) {
        pendingCancel.current?.();
        pendingCancel.current = cancelled;
        pendingRef.current = cb;
        setShowDiscard(true);
      } else {
        cb();
      }
    },
    [dirty],
  );

  // In-app route changes arbitrate through the same dirty-state decision and
  // modal as local selections. Registration precedes route unmount, so a
  // navigation cannot discard the component before the user decides.
  useEffect(() => {
    if (!dirty) return;
    return navigationStore.registerNavigationGuard(
      navigationGuardId.current,
      guard,
    );
  }, [dirty, guard]);

  const onConfirm = useCallback(() => {
    setShowDiscard(false);
    pendingCancel.current = undefined;
    pendingRef.current?.();
    pendingRef.current = null;
  }, []);

  const onCancel = useCallback(() => {
    setShowDiscard(false);
    pendingRef.current = null;
    pendingCancel.current?.();
    pendingCancel.current = undefined;
  }, []);

  // `useCallback`, not a plain function declaration. Declared inline, this is a
  // NEW component type on every host render, so React unmounts and remounts the
  // whole dialog subtree rather than updating it.
  //
  // That was survivable before ConfirmModal gained a real focus trap, because
  // the old effect re-ran `firstBtn?.focus` and papered over it. It is not
  // survivable now: the unmounting instance's cleanup schedules an rAF focus
  // restore, the remounted instance focuses Cancel, and then the stale rAF
  // fires and pulls focus to the trigger BEHIND the open dialog — after which
  // Escape no longer closes it, because the trap's keydown is panel-scoped.
  // The remounted instance also captures `document.activeElement` (`<body>`,
  // mid-swap) as its own return target.
  //
  // The re-render does not need to be unusual. `useServerEvents` invalidates
  // `['config']`, `['connections']`, `['agents']`, `['plugins']` and
  // `['system-status']` on ordinary SSE traffic, and every adopter of this hook
  // is backed by one of them. Six views use it.
  const DiscardModal = useCallback(
    () => (
      <ConfirmModal
        isOpen={showDiscard}
        title="Unsaved Changes"
        message="You have unsaved changes. Discard them?"
        confirmLabel="Discard"
        variant="warning"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    ),
    [showDiscard, onConfirm, onCancel],
  );

  return { guard, DiscardModal };
}
