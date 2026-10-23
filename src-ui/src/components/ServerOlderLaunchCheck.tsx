import { useCoreUpdateStatusQuery } from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { readClientReleaseVersion } from '../build-info';
import {
  coreUpdateScopeFromContext,
  useConnectedServerUpdateContext,
} from '../hooks/useConnectedServerUpdateContext';
import {
  deriveServerOlderOffer,
  serverOlderNoticeContent,
} from '../lib/serverOlderThanClient';
import { serverIdentityMatchesView } from '../views/settings/coreUpdatePresentation';
import {
  clearUpdateNotice,
  openUpdates,
  publishUpdateNotice,
} from './updates/updatesEvents';

export function servedByServer(
  apiBase: string,
  pageOrigin: string | undefined = typeof window === 'undefined'
    ? undefined
    : window.location.origin,
): boolean {
  if (!pageOrigin) return false;
  try {
    return new URL(apiBase, pageOrigin).origin === pageOrigin;
  } catch {
    return false;
  }
}

export function ServerOlderLaunchCheck({
  clientVersion = readClientReleaseVersion(),
}: {
  clientVersion?: string | null;
}) {
  if (clientVersion === null) return null;
  return <ServerOlderCheck clientVersion={clientVersion} />;
}

function ServerOlderCheck({ clientVersion }: { clientVersion: string }) {
  const context = useConnectedServerUpdateContext();
  const sameOrigin = servedByServer(context.apiBase);
  const { data: status, error } = useCoreUpdateStatusQuery(
    context.apiBase,
    {
      enabled:
        !sameOrigin &&
        context.kind !== 'embedded-sidecar' &&
        context.reachability === 'connected' &&
        context.identityReady &&
        !context.nativeObservationPending &&
        !context.claimedOwnerUnresolved,
      staleTime: 5 * 60 * 1000,
    },
    {
      scopeKey: coreUpdateScopeFromContext(context),
      assertCurrent: context.isCurrent,
    },
  );
  const offer = deriveServerOlderOffer({
    clientVersion: sameOrigin ? null : clientVersion,
    status,
    checkFailed: !!error,
    current: context.isCurrent() && context.reachability === 'connected',
    identityMatches: status
      ? serverIdentityMatchesView(status, context.identity)
      : false,
  });
  const content = serverOlderNoticeContent(offer);
  const message = content?.message;
  const detail = content?.detail;
  useEffect(() => {
    if (!message) {
      clearUpdateNotice('server-older');
      return;
    }
    publishUpdateNotice({
      id: 'server-older',
      target: 'server',
      message,
      detail,
      actionLabel: 'Review server update',
      onAction: () => openUpdates('server'),
    });
    return () => clearUpdateNotice('server-older');
  }, [message, detail]);
  return null;
}
