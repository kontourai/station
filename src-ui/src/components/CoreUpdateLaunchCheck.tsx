import {
  type CoreUpdateStatus,
  useCoreUpdateStatusQuery,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useState } from 'react';
import { compare, valid } from 'semver';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';
import { usePlatformProfile } from '../platform/PlatformProfileContext';

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

export function compareVersions(left: string, right: string) {
  return compare(
    immutableVersion(left, 'installed'),
    immutableVersion(right, 'latest'),
  );
}

export function desktopUpdateMessage(status: CoreUpdateStatus): string {
  if (status.installKind === 'source-checkout' && status.behind) {
    return `Station update available — ${status.behind} commit${status.behind === 1 ? '' : 's'} behind.`;
  }
  if (status.channel) {
    return `A Station ${status.channel} update is available.`;
  }
  return 'A Station update is available.';
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

export function validateNativeUpdateFeed(
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
  const { isMobile } = usePlatformProfile();
  const [failure, setFailure] = useState<string | null>(null);
  const [latest, setLatest] = useState<NativeUpdateFeed | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { data: desktopStatus } = useCoreUpdateStatusQuery(apiBase ?? '', {
    // Mobile packages use the immutable, provenance-pinned release feed below.
    // Every other shell asks its selected Station, sharing the exact query key
    // that Settings consumes so opening the review surface does not re-probe.
    enabled: !isMobile,
    staleTime: 5 * 60 * 1000,
  });

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

  // Update state is chrome, so it presents through the one banner slot the
  // shell owns rather than its own markup outside the safe-area layout. An
  // update is never more urgent than reaching the host, so it sits in the
  // lowest band and stays dismissible.
  useEffect(() => {
    if (!failure) {
      bannerStore.dismiss(BANNER_IDS.updateCheck);
      return;
    }
    bannerStore.present({
      id: BANNER_IDS.updateCheck,
      priority: BANNER_PRIORITY.info,
      tone: 'warning',
      message: `Update check failed: ${failure}`,
      occurrence: failure,
      dismissible: true,
      actions: [{ label: 'Retry update check', onClick: retry }],
    });
    return () => {
      bannerStore.dismiss(BANNER_IDS.updateCheck);
    };
  }, [failure, retry]);

  useEffect(() => {
    const availableDesktopStatus =
      !isMobile && desktopStatus?.updateAvailable ? desktopStatus : null;
    if (!latest && !availableDesktopStatus) {
      bannerStore.dismiss(BANNER_IDS.updateAvailable);
      return;
    }
    if (latest) {
      const { version, releaseUrl } = latest;
      bannerStore.present({
        id: BANNER_IDS.updateAvailable,
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        ariaLive: 'polite',
        message: `Station ${version} is available.`,
        occurrence: version,
        dismissible: true,
        actions: [{ label: 'Update Station', href: releaseUrl }],
      });
    } else if (availableDesktopStatus) {
      bannerStore.present({
        id: BANNER_IDS.updateAvailable,
        priority: BANNER_PRIORITY.info,
        tone: 'info',
        ariaLive: 'polite',
        message: desktopUpdateMessage(availableDesktopStatus),
        occurrence:
          availableDesktopStatus.remoteHash ??
          desktopUpdateMessage(availableDesktopStatus),
        dismissible: true,
        // Settings owns the install-specific truth: git pull, verified
        // self-update, or reinstall guidance. The launch banner only claims
        // that an update exists and never advertises an unavailable action.
        actions: [
          {
            label: 'Review update',
            href: '/settings?view=system&highlight=core-app-updates',
          },
        ],
      });
    }
    return () => {
      bannerStore.dismiss(BANNER_IDS.updateAvailable);
    };
  }, [desktopStatus, isMobile, latest]);

  return null;
}
