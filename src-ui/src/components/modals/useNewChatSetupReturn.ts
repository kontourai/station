import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { BANNER_PRIORITY, bannerStore } from '../../contexts/banner-store';
import {
  type NavigationState,
  navigationStore,
} from '../../contexts/navigation-store';

export type NewChatSetupAuthority = ReturnType<
  typeof useHostRequestAuthorityScope
>;

type SetupJourney = {
  origin: NavigationState;
  target: string;
  authority: NonNullable<NewChatSetupAuthority>;
  entered: boolean;
  returnRequested?: boolean;
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
}: {
  authority: NewChatSetupAuthority;
  onCancel: () => void;
  onResume: () => void;
}) {
  const id = `chrome:new-chat:setup-return:${useId()}`;
  const [journey, setJourney] = useState<SetupJourney | null>(null);
  const current = useRef<SetupJourney | null>(null);
  const callbacks = useRef({ onCancel, onResume });
  callbacks.current = { onCancel, onResume };

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
      if (
        restoreRoute &&
        navigationStore.getSnapshot().pathname !== pending.origin.pathname
      ) {
        pending.returnRequested = true;
        const origin = pending.origin;
        // Project navigation remains owned by the canonical Layout/Project seam.
        if (origin.selectedProject && origin.selectedProjectLayout) {
          navigationStore.setLayout(
            origin.selectedProject,
            origin.selectedProjectLayout,
          );
        } else if (origin.selectedProject) {
          navigationStore.setProject(origin.selectedProject);
        } else {
          navigationStore.navigate(origin.pathname);
        }
        // A dirty setup form may defer navigation. Keep the picker suspended
        // until the canonical navigation store actually admits the return.
        return;
      }
      current.current = null;
      setJourney(null);
      bannerStore.dismiss(id, { reason: 'system' });
      callbacks.current.onResume();
    },
    [cancel, id],
  );

  const begin = useCallback(
    (target: string) => {
      if (!authority?.isCurrent()) return false;
      const next = {
        origin: navigationStore.getSnapshot(),
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
      message: 'Your New Chat choices are waiting while you finish setup.',
      actions: [
        {
          label: 'Return to New Chat',
          variant: 'primary',
          onClick: () => resume(true),
        },
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
      const location = navigationStore.getSnapshot();
      const path = location.pathname;
      if (
        pending.returnRequested &&
        pending.origin.selectedProject &&
        location.selectedProject === pending.origin.selectedProject &&
        location.selectedProjectLayout === pending.origin.selectedProjectLayout
      ) {
        resume(false);
        return;
      }
      if (isRepairRoute(path, pending.target)) return;
      if (path === pending.origin.pathname) resume(false);
      else cancel();
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
