import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { BANNER_PRIORITY, bannerStore } from '../../contexts/banner-store';
import {
  type NavigationLocation,
  navigationStore,
} from '../../contexts/navigation-store';
import { useIsMobile } from '../../hooks/useIsMobile';

export type NewChatSetupAuthority = ReturnType<
  typeof useHostRequestAuthorityScope
>;

type SetupJourney = {
  origin: NavigationLocation;
  target: string;
  authority: NonNullable<NewChatSetupAuthority>;
  entered: boolean;
  controller: AbortController;
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
  workflowLabel = 'New Chat',
  readyToResume = false,
  allowedPaths,
}: {
  authority: NewChatSetupAuthority;
  onCancel: () => void;
  onResume: (error?: unknown) => void;
  revalidate: () => Promise<unknown>;
  workflowLabel?: string;
  readyToResume?: boolean;
  allowedPaths?: readonly string[];
}) {
  const isMobile = useIsMobile();
  const id = `chrome:new-chat:setup-return:${useId()}`;
  const [journey, setJourney] = useState<SetupJourney | null>(null);
  const current = useRef<SetupJourney | null>(null);
  const callbacks = useRef({ onCancel, onResume, revalidate });
  callbacks.current = { onCancel, onResume, revalidate };

  const cancel = useCallback(() => {
    if (!current.current) return;
    const pending = current.current;
    current.current = null;
    pending.controller.abort();
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
        void navigationStore
          .restoreLocation(pending.origin, {
            current: () =>
              current.current === pending && pending.authority.isCurrent(),
            prepare: async () => true,
            signal: pending.controller.signal,
          })
          .then(() => {
            if (current.current === pending && !pending.authority.isCurrent())
              cancel();
          });
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
          (error: unknown) => {
            if (current.current !== checking) return;
            if (!checking.authority.isCurrent()) {
              cancel();
              return;
            }
            current.current = null;
            setJourney(null);
            bannerStore.dismiss(id, { reason: 'system' });
            callbacks.current.onResume(
              error instanceof Error
                ? error
                : new Error('Chat setup could not be verified.'),
            );
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
        controller: new AbortController(),
      };
      // Retain the dialog until navigation commits, so its history cleanup cannot queue Back over the destination.
      current.current = next;
      setJourney(next);
      return true;
    },
    [authority],
  );

  const retry = useCallback(() => {
    if (!authority?.isCurrent()) return false;
    const next = {
      origin: navigationStore.captureLocation(),
      target: navigationStore.getSnapshot().pathname,
      authority,
      entered: true,
      controller: new AbortController(),
    };
    current.current = next;
    setJourney(next);
    resume(false);
    return true;
  }, [authority, resume]);

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
        ? `Checking ${workflowLabel} setup before returning.`
        : `Your ${workflowLabel} draft is waiting while you finish setup.`,
      actions: [
        ...(!journey.revalidating
          ? [
              {
                label: `Return to ${workflowLabel}`,
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
      // Ignore this initiating navigation, including setup opened from the
      // very same Connections page. Only a later Back can mean return.
      void navigationStore
        .navigateWithPrecommit(
          journey.target,
          {
            current: () =>
              current.current === journey && journey.authority.isCurrent(),
            prepare: async () => true,
            signal: journey.controller.signal,
          },
          { maximize: null, ...(isMobile ? { dock: null } : {}) },
        )
        .then((committed) => {
          if (current.current !== journey) return;
          if (!journey.authority.isCurrent()) {
            cancel();
            return;
          }
          if (committed) {
            journey.entered = true;
            setJourney({ ...journey });
          } else {
            current.current = null;
            setJourney(null);
            bannerStore.dismiss(id, { reason: 'system' });
            callbacks.current.onResume(
              new Error(
                'Could not open setup. Your draft is retained; try again.',
              ),
            );
          }
        });
    }
  }, [authority, cancel, id, journey, resume, workflowLabel, isMobile]);

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
      if (
        isRepairRoute(path, pending.target) ||
        allowedPaths?.some(
          (prefix) => path === prefix || path.startsWith(`${prefix}/`),
        )
      )
        return;
      cancel();
    });
    return () => {
      unsubscribe();
    };
  }, [allowedPaths, cancel, resume]);

  useEffect(() => {
    if (journey?.entered && !journey.revalidating && readyToResume)
      resume(true);
  }, [journey, readyToResume, resume]);

  useEffect(
    () => () => {
      current.current?.controller.abort();
      current.current = null;
      bannerStore.dismiss(id, { reason: 'system' });
    },
    [id],
  );

  return {
    pending: journey !== null,
    suspended:
      journey !== null && (journey.entered || journey.revalidating === true),
    begin,
    retry,
    close: () => {
      // Navigation also closes the registered dialog; the pending journey still owns its draft.
      if (current.current) return false;
      callbacks.current.onCancel();
      return true;
    },
  };
}
