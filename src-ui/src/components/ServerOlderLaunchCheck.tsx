import {
  useApplyCoreUpdateMutation,
  useCoreUpdateStatusQuery,
  useServiceUpdateProgressQuery,
} from '@kontourai/station-sdk';
import { useEffect, useReducer, useRef, useState } from 'react';
import { readClientReleaseVersion } from '../build-info';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  type BannerAction,
  bannerStore,
} from '../contexts/banner-store';
import {
  coreUpdateScopeFromContext,
  useConnectedServerUpdateContext,
} from '../hooks/useConnectedServerUpdateContext';
import {
  deriveServerOlderOffer,
  progressPollInterval,
  serverOlderBannerContent,
  serverUpdateFlowReducer,
} from '../lib/serverOlderThanClient';
import { serverIdentityMatchesView } from '../views/settings/coreUpdatePresentation';
import { settingsDeepLinkUrl } from '../views/settings/settings-deep-link';

/** Matches the Settings card: staging, a backup and two trials fit inside. */
const FOLLOW_MS = 45 * 60 * 1000;

/**
 * True when the page was loaded from the server it talks to. That UI is the
 * server's own build, never a newer client, whatever version it carries.
 */
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

/**
 * Tells the reader when the Station server they reach is older than this app
 * (#2675), and updates it in one click when the server can update itself.
 * Desktop and mobile shells render this same UI; an embedded server, which
 * updates with its desktop app, never gets here.
 */
export function ServerOlderLaunchCheck({
  clientVersion = readClientReleaseVersion(),
}: {
  clientVersion?: string | null;
}) {
  // A dev or locally built app has no release version to compare: it mounts
  // nothing below, so it asks the server nothing and holds no update state.
  if (clientVersion === null) return null;
  return <ServerOlderCheck clientVersion={clientVersion} />;
}

function ServerOlderCheck({ clientVersion }: { clientVersion: string }) {
  const context = useConnectedServerUpdateContext();
  // Each selection owns its mutation observer and update-following state.
  const connectionScope = `${context.apiBase}\u0000${context.scopeKey ?? 'no-scope'}`;
  return (
    <ScopedServerOlderCheck
      key={connectionScope}
      clientVersion={clientVersion}
      context={context}
      connectionScope={connectionScope}
    />
  );
}

function ScopedServerOlderCheck({
  clientVersion,
  context,
  connectionScope,
}: {
  clientVersion: string;
  context: ReturnType<typeof useConnectedServerUpdateContext>;
  connectionScope: string;
}) {
  const { apiBase } = context;
  const sameOrigin = servedByServer(apiBase);
  const scopeKey = coreUpdateScopeFromContext(context);
  const {
    data: status,
    error: checkError,
    refetch,
    dataUpdatedAt: statusUpdatedAt,
  } = useCoreUpdateStatusQuery(
    apiBase,
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
    // The same scoped query Settings and the launch check read.
    { scopeKey, assertCurrent: context.isCurrent },
  );

  const [flow, dispatch] = useReducer(serverUpdateFlowReducer, {
    phase: 'idle',
  });

  const apply = useApplyCoreUpdateMutation(apiBase, {
    onSuccess: (data) => {
      if (data?.success && data.serviceUpdate?.requestId) {
        dispatch({
          type: 'accepted',
          requestId: data.serviceUpdate.requestId,
        });
      } else {
        dispatch({
          type: 'refused',
          message: 'the server did not queue a service update.',
        });
      }
    },
    onError: (error) => {
      dispatch({ type: 'refused', message: error.message });
    },
  });

  const following = flow.phase === 'following';
  const progressQuery = useServiceUpdateProgressQuery(apiBase, {
    enabled: following,
    scopeKey: connectionScope,
    refetchInterval: () => progressPollInterval(flow),
  });
  const { data: progress, dataUpdatedAt, errorUpdatedAt } = progressQuery;
  useEffect(() => {
    if (!following) return;
    if (errorUpdatedAt > dataUpdatedAt) {
      dispatch({ type: 'progress-unreachable' });
    } else if (progress) {
      dispatch({ type: 'progress', progress });
    }
  }, [following, progress, dataUpdatedAt, errorUpdatedAt]);

  useEffect(() => {
    if (!following) return;
    const timer = setTimeout(() => dispatch({ type: 'expired' }), FOLLOW_MS);
    return () => clearTimeout(timer);
  }, [following]);

  // The update ended (with an outcome, or with following given up while it
  // may still have committed): re-read the server so the offer reflects what
  // it runs. Until a check made after that answers, the old comparison is
  // history: it must not offer the update that just ran.
  const concluded = flow.phase === 'finished' || flow.phase === 'expired';
  const [outcomeAt, setOutcomeAt] = useState<number | null>(null);
  useEffect(() => {
    if (!concluded) return;
    setOutcomeAt(Date.now());
    void refetch();
  }, [concluded, refetch]);
  const awaitingRecheck =
    outcomeAt !== null && (statusUpdatedAt ?? 0) <= outcomeAt;

  const offer = deriveServerOlderOffer({
    clientVersion: sameOrigin ? null : clientVersion,
    status: awaitingRecheck ? undefined : status,
    checkFailed: !!checkError,
    current: context.isCurrent() && context.reachability === 'connected',
    serverKey:
      status?.serverIdentity?.instanceId ??
      context.identity?.instanceId ??
      apiBase,
    identityMatches: status
      ? serverIdentityMatchesView(status, context.identity)
      : false,
  });
  const instance =
    status?.serverIdentity?.instanceId ?? context.identity?.instanceId;
  // Serialized so the banner re-presents only when what it says changes.
  const contentJson = JSON.stringify(
    serverOlderBannerContent(offer, flow, instance),
  );

  const mutate = apply.mutate;
  // The update button leaves with the offer; focus moves to the banner's
  // progress text so the keyboard is not dropped onto the page.
  const focusProgressRef = useRef(false);
  useEffect(() => {
    const content = JSON.parse(contentJson) as ReturnType<
      typeof serverOlderBannerContent
    >;
    if (!content) {
      bannerStore.dismiss(BANNER_IDS.serverOlder);
      return;
    }
    const actions: BannerAction[] = content.actions.map((action) =>
      action.kind === 'apply'
        ? {
            label: action.label,
            variant: 'primary' as const,
            onClick: () => {
              focusProgressRef.current = true;
              dispatch({ type: 'apply', scope: connectionScope });
              mutate();
            },
          }
        : {
            label: action.label,
            href: settingsDeepLinkUrl({
              view: 'system',
              highlight: 'core-app-updates',
            }),
          },
    );
    bannerStore.present({
      id: BANNER_IDS.serverOlder,
      priority: BANNER_PRIORITY.info,
      tone: content.tone,
      ariaLive: 'polite',
      message: content.message,
      ...(content.detail ? { detail: content.detail } : {}),
      occurrence: content.occurrence,
      dismissible: true,
      // Dismissing an outcome closes it; a running update keeps running.
      onDismiss: () => dispatch({ type: 'dismiss' }),
      actions,
    });
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    if (focusProgressRef.current && content.actions.length === 0) {
      focusProgressRef.current = false;
      // After the host renders the new message.
      focusTimer = setTimeout(() => {
        const text = document.querySelector<HTMLElement>(
          `[data-banner-id="${BANNER_IDS.serverOlder}"] .banner-host__live`,
        );
        if (!text) return;
        text.tabIndex = -1;
        text.focus();
      }, 0);
    }
    return () => {
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      bannerStore.dismiss(BANNER_IDS.serverOlder);
    };
  }, [contentJson, connectionScope, mutate]);

  return null;
}
