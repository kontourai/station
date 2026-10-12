import {
  useApplyCoreUpdateMutation,
  useCoreUpdateStatusQuery,
  useServiceUpdateProgressQuery,
} from '@kontourai/station-sdk';
import { useEffect, useReducer } from 'react';
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
  serverOlderBannerContent,
  serverUpdateFlowReducer,
} from '../lib/serverOlderThanClient';
import { serverIdentityMatchesView } from '../views/settings/coreUpdatePresentation';
import { settingsDeepLinkUrl } from '../views/settings/settings-deep-link';

const PROGRESS_POLL_MS = 2_000;
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
  const relevantBuild = clientVersion !== null;
  const context = useConnectedServerUpdateContext({
    identityEnabled: relevantBuild,
  });
  const { apiBase } = context;
  const sameOrigin = servedByServer(apiBase);
  const scopeKey = coreUpdateScopeFromContext(context);
  const {
    data: status,
    error: checkError,
    refetch,
  } = useCoreUpdateStatusQuery(
    apiBase,
    {
      enabled:
        relevantBuild &&
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

  // A service update restarts the server, so it is followed per connection,
  // not per boot.
  const connectionScope = `${apiBase}\u0000${context.scopeKey ?? 'no-scope'}`;
  const [flow, dispatch] = useReducer(serverUpdateFlowReducer, {
    phase: 'idle',
  });
  const flowScope = flow.phase === 'idle' ? null : flow.scope;
  useEffect(() => {
    if (flowScope !== null && flowScope !== connectionScope) {
      dispatch({ type: 'reset' });
    }
  }, [flowScope, connectionScope]);

  const apply = useApplyCoreUpdateMutation(apiBase, {
    onSuccess: (data) => {
      if (data?.serviceUpdate?.requestId) {
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
    refetchInterval: () => (following ? PROGRESS_POLL_MS : false),
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

  // The outcome is in: re-read the server so the offer reflects what it runs.
  const finished = flow.phase === 'finished';
  useEffect(() => {
    if (finished) void refetch();
  }, [finished, refetch]);

  const offer = deriveServerOlderOffer({
    clientVersion: sameOrigin ? null : clientVersion,
    status,
    checkFailed: !!checkError,
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
      // Dismissing an outcome closes it; the offer may speak again.
      onDismiss: () => dispatch({ type: 'reset' }),
      actions,
    });
    return () => {
      bannerStore.dismiss(BANNER_IDS.serverOlder);
    };
  }, [contentJson, connectionScope, mutate]);

  return null;
}
