import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { BANNER_PRIORITY, bannerStore } from '../../contexts/banner-store';
import {
  type NavigationLocation,
  navigationStore,
} from '../../contexts/navigation-store';

export type NewChatSetupAuthority = ReturnType<
  typeof useHostRequestAuthorityScope
>;

type SetupJourney = {
  origin: NavigationLocation;
  target: string;
  authority: NonNullable<NewChatSetupAuthority>;
  entered: boolean;
  revalidating?: boolean;
};

function isRepairRoute(path: string, target: string) {
  return target.startsWith('/connections')
    ? path === '/connections' || path.startsWith('/connections/')
    : path === target;
}

/** The picker keeps its own draft while its dialog is absent during setup. */
export function useNewChatSetupReturn({
  authority,
  onCancel,
  onResume,
  revalidate,
}: {
  authority: NewChatSetupAuthority;
  onCancel: () => void;
  onResume: () => void;
  revalidate: () => Promise<unknown>;
}) {
  const id = `chrome:new-chat:setup-return:${useId()}`;
  const [journey, setJourney] = useState<SetupJourney | null>(null);
  const current = useRef<SetupJourney | null>(null);
  const callbacks = useRef({ onCancel, onResume, revalidate });
  callbacks.current = { onCancel, onResume, revalidate };

  const cancel = useCallback(() => {
    if (!current.current) return;
    current.current = null;
    setJourney(null);
    bannerStore.dismiss(id, { reason: 'system' });
    callbacks.current.onCancel();
  }, [id]);

  const resume = useCallback(
    (restoreRoute: boolean) => {
      const pending = current.current;
      if (!pending) return;
      if (!pending.authority.isCurrent()) {
        cancel();
        return;
      }
      if (restoreRoute && !navigationStore.isCurrentLocation(pending.origin)) {
        navigationStore.restoreLocation(pending.origin);
        // A dirty setup form can defer the exact path/query restoration.
        return;
      }
      if (pending.revalidating) return;
      const checking = { ...pending, revalidating: true };
      current.current = checking;
      setJourney(checking);
      // Query refetch promises are the admission barrier. Do not expose the
      // picker in the interval before batched query observers report fetching.
      void Promise.resolve()
        .then(() => callbacks.current.revalidate())
        .then(
          () => {
            if (current.current !== checking) return;
            if (!checking.authority.isCurrent()) {
              cancel();
              return;
            }
            current.current = null;
            setJourney(null);
            bannerStore.dismiss(id, { reason: 'system' });
            callbacks.current.onResume();
          },
          () => {
            // An unexpected revalidation rejection cannot admit stale choices.
            if (current.current === checking) cancel();
          },
        );
    },
    [cancel, id],
  );

  const begin = useCallback(
    (target: string) => {
      if (!authority?.isCurrent()) return false;
      const next = {
        origin: navigationStore.captureLocation(),
        target,
        authority,
        entered: false,
      };
      // Synchronous ownership fences the old dialog's history cleanup before
      // React removes it. The route changes only after that dialog unmounts.
      current.current = next;
      setJourney(next);
      return true;
    },
    [authority],
  );

  useEffect(() => {
    if (!journey) return;
    if (
      authority?.authorityKey !== journey.authority.authorityKey ||
      authority.apiBase !== journey.authority.apiBase ||
      !journey.authority.isCurrent()
    ) {
      cancel();
      return;
    }
    bannerStore.present({
      id,
      priority: BANNER_PRIORITY.setup,
      tone: 'info',
      userInitiated: true,
      message: journey.revalidating
        ? 'Checking chat setup before returning.'
        : 'Your New Chat choices are waiting while you finish setup.',
      actions: [
        ...(!journey.revalidating
          ? [
              {
                label: 'Return to New Chat',
                variant: 'primary' as const,
                onClick: () => resume(true),
              },
            ]
          : []),
        { label: 'Cancel return', onClick: cancel },
      ],
      dismissible: false,
    });
    if (!journey.entered) {
      journey.entered = true;
      navigationStore.navigate(journey.target);
    }
  }, [authority, cancel, id, journey, resume]);

  useEffect(() => {
    const unsubscribe = navigationStore.subscribe(() => {
      const pending = current.current;
      if (!pending?.entered) return;
      if (!pending.authority.isCurrent()) {
        cancel();
        return;
      }
      if (navigationStore.isCurrentLocation(pending.origin)) {
        resume(false);
        return;
      }
      const path = navigationStore.getSnapshot().pathname;
      if (isRepairRoute(path, pending.target)) return;
      cancel();
    });
    return () => {
      unsubscribe();
    };
  }, [cancel, resume]);

  useEffect(
    () => () => {
      current.current = null;
      bannerStore.dismiss(id, { reason: 'system' });
    },
    [id],
  );

  return {
    suspended: journey !== null,
    begin,
    close: () => {
      if (!current.current) callbacks.current.onCancel();
    },
  };
}
