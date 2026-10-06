import type { NativeRelayLinkDelivery } from '@kontourai/station-contracts/native-relay-link';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { LazyBoundary } from '../../components/LazyBoundary';
import { SkeletonBlock } from '../../components/state';
import { usePlatformProfile } from '../PlatformProfileContext';
import { subscribeNativeRelayLinks } from './nativeRelayLinkAdapter';
import { cancelNativeRelayLink } from './nativeRelayLinkCancellation';

const loadReview = () =>
  import('./NativeRelayLinkReview').then((module) => ({
    default: module.NativeRelayLinkReview,
  }));

/** Cold intake precedes protected roots; warm intake preserves their owners. */
export function NativeRelayLinkIntakeController({
  children,
}: {
  children: ReactNode;
}) {
  const profile = usePlatformProfile();
  const enabled = profile.isTauri && profile.target === 'ios';
  const allowDevelopmentHttp = profile.isDevBuild && profile.channel === 'dev';
  const subscriptionEpoch = useRef(0);
  const [ready, setReady] = useState(!enabled);
  const [childrenStarted, setChildrenStarted] = useState(!enabled);
  const [pending, setPending] = useState<NativeRelayLinkDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redeemedPendingId, setRedeemedPendingId] = useState<string | null>(
    null,
  );
  const redeemedPendingIdRef = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  const current = useRef<NativeRelayLinkDelivery | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const epoch = ++subscriptionEpoch.current;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeNativeRelayLinks((value) => {
      if (disposed) {
        queueMicrotask(() => {
          if (subscriptionEpoch.current === epoch && value.kind !== 'rejected')
            void cancelNativeRelayLink(value.pendingId).catch(() => undefined);
        });
        return;
      }
      if (value.kind !== 'rejected') {
        if (seen.current.has(value.pendingId)) return;
        seen.current.add(value.pendingId);
        if (seen.current.size > 64) {
          const oldest = seen.current.values().next().value;
          if (oldest) seen.current.delete(oldest);
        }
      }
      const previous = current.current;
      current.current = value;
      setPending(value);
      setError(null);
      if (previous && previous.kind !== 'rejected')
        void cancelNativeRelayLink(previous.pendingId).catch(() => undefined);
    }, allowDevelopmentHttp)
      .then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        setReady(true);
      })
      .catch(() => {
        if (!disposed) {
          setError(
            'Couldn’t open this Station invitation. Close and reopen Station before continuing.',
          );
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
      queueMicrotask(() => {
        if (subscriptionEpoch.current !== epoch) return;
        const owned = current.current;
        if (owned && owned.kind !== 'rejected')
          void cancelNativeRelayLink(owned.pendingId).catch(() => undefined);
      });
    };
  }, [enabled, allowDevelopmentHttp]);
  useEffect(() => {
    if (ready && !pending) setChildrenStarted(true);
  }, [ready, pending]);
  useEffect(() => {
    if (
      pending?.kind !== 'bound-invitation' ||
      pending.pendingId === redeemedPendingId
    )
      return;
    const owner = pending;
    if (owner.invitation.expiresAt === Number.MAX_SAFE_INTEGER) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function checkExpiry() {
      if (
        current.current !== owner ||
        redeemedPendingIdRef.current === owner.pendingId
      )
        return;
      const remaining = owner.invitation.expiresAt - Date.now();
      if (remaining > 0) {
        timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
        return;
      }
      const expired: NativeRelayLinkDelivery = {
        kind: 'rejected',
        code: 'expired',
        message:
          'This Station invitation has expired. Ask the operator for a new link.',
      };
      current.current = expired;
      setPending(expired);
      void cancelNativeRelayLink(owner.pendingId).catch(() => undefined);
    }
    checkExpiry();
    return () => clearTimeout(timer);
  }, [pending, redeemedPendingId]);
  function redemptionConfirmed(pendingId: string) {
    const owner = current.current;
    if (owner?.kind === 'bound-invitation' && owner.pendingId === pendingId) {
      redeemedPendingIdRef.current = pendingId;
      setRedeemedPendingId(pendingId);
    }
  }
  async function close() {
    const closing = current.current;
    try {
      if (closing && closing.kind !== 'rejected')
        await cancelNativeRelayLink(closing.pendingId);
      if (current.current !== closing) return;
      current.current = null;
      setPending(null);
      setError(null);
    } catch {
      if (current.current === closing)
        setError(
          'Couldn’t close this invitation. Check the connection’s status before continuing.',
        );
    }
  }
  if (!enabled) return children;
  return (
    <>
      {childrenStarted ? (
        <div
          style={{ display: 'contents' }}
          inert={Boolean(pending)}
          aria-hidden={pending ? true : undefined}
        >
          {children}
        </div>
      ) : !pending ? (
        <SkeletonBlock label="Checking Station invitations" />
      ) : null}
      {pending ? (
        <LazyBoundary
          key={pending.kind === 'rejected' ? 'rejected' : pending.pendingId}
          load={loadReview}
          componentProps={{
            delivery: pending,
            onClose: () => void close(),
            onRedemptionConfirmed: redemptionConfirmed,
          }}
          pending={<SkeletonBlock label="Opening Station invitation" />}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
