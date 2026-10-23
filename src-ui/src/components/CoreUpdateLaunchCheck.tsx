import {
  type CoreUpdateStatus,
  useCoreUpdateStatusQuery,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useState } from 'react';
import { compare, valid } from 'semver';
import {
  coreUpdateScopeFromContext,
  useConnectedServerUpdateContext,
} from '../hooks/useConnectedServerUpdateContext';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import {
  clearUpdateNotice,
  openUpdates,
  publishUpdateNotice,
} from './updates/updatesEvents';

interface NativeUpdateFeed {
  channel: string;
  version: string;
  releaseUrl: string;
}

function immutableVersion(value: unknown, label: string) {
  if (typeof value !== 'string' || valid(value) === null) {
    throw new Error(`invalid immutable ${label} version`);
  }
  return value;
}

function compareVersions(left: string, right: string) {
  return compare(
    immutableVersion(left, 'installed'),
    immutableVersion(right, 'latest'),
  );
}

/**
 * The launch banner's source wording, derived from a source checkout's own
 * comparison counts (S5) — never from `updateAvailable` alone and never from
 * a stamped build's SHA inequality (S10), which is a build-stamp fact and
 * does not establish that an installable release exists. A diverged checkout
 * is manual work, not an offered update.
 */
function sourceComparisonMessage(status: CoreUpdateStatus): string | null {
  if (status.installKind !== 'source-checkout') return null;
  const behind = status.behind;
  if (typeof behind !== 'number' || behind <= 0) return null;
  if ((status.ahead ?? 0) > 0) return null;
  return `Server checkout is ${behind} commit${behind === 1 ? '' : 's'} behind its configured upstream.`;
}

function normalizedOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('invalid update provider origin');
  }
  return url.origin;
}

function validateNativeUpdateFeed(
  value: unknown,
  _providerOrigin: string,
  channel = 'stable',
): NativeUpdateFeed {
  if (!value || typeof value !== 'object')
    throw new Error('invalid update feed');
  const {
    version,
    releaseUrl,
    channel: actualChannel,
  } = value as Record<string, unknown>;
  if (actualChannel !== channel)
    throw new Error('update feed channel mismatch');
  immutableVersion(version, 'latest');
  if (typeof releaseUrl !== 'string')
    throw new Error('invalid update release URL');
  const parsed = new URL(releaseUrl);
  if (parsed.protocol !== 'https:')
    throw new Error('update release URL must use HTTPS');
  return { channel, version: version as string, releaseUrl };
}

export function CoreUpdateLaunchCheck({
  apiBase,
  feedUrl = import.meta.env.VITE_NATIVE_APP_UPDATE_FEED_URL,
  providerOrigin = import.meta.env.VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN,
  installedVersion = import.meta.env.VITE_NATIVE_APP_VERSION,
  channel = import.meta.env.VITE_NATIVE_APP_UPDATE_CHANNEL || 'stable',
}: {
  apiBase?: string;
  feedUrl?: string;
  providerOrigin?: string;
  installedVersion?: string;
  channel?: string;
}) {
  const { isMobile, isDesktop } = usePlatformProfile();
  // A launch check that owns no desktop native correlation never needs the
  // identity roundtrip: mobile uses the release feed below, and a browser
  // cannot host an embedded sidecar.
  const context = useConnectedServerUpdateContext({
    identityEnabled: isDesktop,
  });
  const [failure, setFailure] = useState<string | null>(null);
  const [latest, setLatest] = useState<NativeUpdateFeed | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = coreUpdateScopeFromContext(context);
  const { data: desktopStatus } = useCoreUpdateStatusQuery(
    apiBase ?? '',
    {
      // Mobile packages use the immutable, provenance-pinned release feed below.
      // Every other shell asks its selected Station, sharing the exact query key
      // that Settings consumes so opening the review surface does not re-probe.
      // On a desktop shell the source query waits for the connected-server
      // correlation: an established embedded sidecar is updated with this
      // desktop app and must never fire it, a pending identity or native
      // observation knows too little to start one. A browser shell keeps its
      // pre-correlation behavior: no sidecar is possible there, so the launch
      // banner rests on the server's own comparison facts.
      enabled:
        !isMobile &&
        (!isDesktop ||
          (context.identityReady &&
            !context.nativeObservationPending &&
            !context.claimedOwnerUnresolved &&
            context.kind !== 'embedded-sidecar')),
      staleTime: 5 * 60 * 1000,
    },
    // Same scoped query as Settings: a superseded selection's comparison can
    // neither answer for the new scope nor settle into its cache.
    { scopeKey, assertCurrent: context.isCurrent },
  );

  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    // `attempt` is an explicit retry generation, not remote state.
    void attempt;
    if (!isMobile) return;
    // A build with no update feed has not failed a check — it was built
    // without an update channel, which is correct for a dev/debug build.
    // Reporting that state as build identity is archive#2211; it is not an alert.
    if (!feedUrl || !providerOrigin || !installedVersion) return;
    let feed: URL;
    let trustedOrigin: string;
    try {
      feed = new URL(feedUrl);
      trustedOrigin = normalizedOrigin(providerOrigin);
      immutableVersion(installedVersion, 'installed');
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : 'Invalid update configuration.',
      );
      return;
    }
    if (feed.protocol !== 'https:' || feed.origin !== trustedOrigin) {
      setFailure('Native app update feed has untrusted provenance.');
      return;
    }
    const controller = new AbortController();
    void fetch(feed, {
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    })
      .then(async (response) => {
        if (!response.ok || new URL(response.url).origin !== trustedOrigin)
          throw new Error('update provider response was not trusted');
        const result = validateNativeUpdateFeed(
          await response.json(),
          trustedOrigin,
          channel,
        );
        setLatest(
          compareVersions(installedVersion, result.version) < 0 ? result : null,
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error
              ? error.message
              : 'Native app update check failed.',
          );
      });
    return () => controller.abort();
  }, [attempt, channel, feedUrl, installedVersion, isMobile, providerOrigin]);

  useEffect(() => {
    if (!failure) {
      clearUpdateNotice('launch-check-failed');
      return;
    }
    publishUpdateNotice({
      id: 'launch-check-failed',
      target: 'desktop',
      message: 'Could not check for app updates.',
      detail: failure,
      actionLabel: 'Retry update check',
      onAction: retry,
    });
    return () => clearUpdateNotice('launch-check-failed');
  }, [failure, retry]);

  useEffect(() => {
    const sourceMessage = desktopStatus
      ? sourceComparisonMessage(desktopStatus)
      : null;
    if (latest) {
      publishUpdateNotice({
        id: 'launch-update',
        target: 'desktop',
        message: `Station ${latest.version} is available.`,
        href: latest.releaseUrl,
        actionLabel: 'Update app',
      });
    } else if (
      !isMobile &&
      context.kind !== 'embedded-sidecar' &&
      sourceMessage
    ) {
      publishUpdateNotice({
        id: 'launch-update',
        target: 'server',
        message: sourceMessage,
        actionLabel: 'Review server update',
        onAction: () => openUpdates('server'),
      });
    } else {
      clearUpdateNotice('launch-update');
    }
    return () => clearUpdateNotice('launch-update');
  }, [context.kind, desktopStatus, isMobile, latest]);

  return null;
}
