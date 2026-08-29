/**
 * archive#3089: projects the server-derived runtime resource posture
 * (`GET /api/system/resource-posture`, backed by
 * `src-server/services/infra/resource-posture.ts`) into the chrome banner
 * queue. Healthy (and unavailable — the probe already fails open, so an
 * absent reading is not itself a user-facing incident) render nothing: an
 * always-on chip would be noise. Degraded and critical are the two states
 * that change what the user should do, so those are the only ones that ever
 * reach `bannerStore`.
 *
 * The displayed `busyPercent` is the exact field the route read from the
 * SAME probe `admitEngineStart`/`admitScheduledJob` evaluate — this
 * component never recomputes host pressure, it only renders what the query
 * returned (see `packages/sdk/src/query-domains/resourcePosture.ts`).
 *
 * Polling, not push: posture is time-varying and there is no server-side
 * push channel for it. `useResourcePostureQuery`'s 15s `refetchInterval`
 * (matching `operatingState.ts`'s cadence for the same class of host-state
 * poll) bounds how stale a rendered reading can be — this app disables
 * refetch-on-focus/mount globally, so the interval is the only freshness
 * mechanism, not a supplementary one.
 *
 * Not mounted eagerly (archive#3089 bundle-budget note): the app entry
 * bundle has ~0 bytes of headroom, and this condition is invisible in the
 * common (healthy) case anyway, so `App.tsx` loads this component through
 * the same `LazyBoundary` chunk pattern `CoreUpdateLaunchCheck` uses rather
 * than importing it (and the SDK hook it pulls in) into the eager graph.
 */
import { useResourcePostureQuery } from '@kontourai/station-sdk/resource-posture';
import { useEffect } from 'react';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../../contexts/banner-store';
import {
  type HostPressureKind,
  hostPressureBadge,
} from '../../utils/resourcePosture';

const RESOURCE_POSTURE_BANNER_ID = BANNER_IDS.resourcePosture;

function postureBannerMessage(
  kind: HostPressureKind,
  posture: {
    busyPercent?: number;
    smoothedBusyPercent?: number;
    windowLength?: number;
    ageMs?: number | null;
  },
): string {
  const displayed = posture.smoothedBusyPercent ?? posture.busyPercent;
  const observed =
    typeof displayed === 'number'
      ? `${Math.round(displayed)}% CPU busy averaged across ${posture.windowLength ?? 1} sample${(posture.windowLength ?? 1) === 1 ? '' : 's'}`
      : 'over its resource threshold';
  const age =
    typeof posture.ageMs === 'number'
      ? `, observed ${Math.max(0, Math.round(posture.ageMs / 1000))}s ago`
      : '';
  return kind === 'critical'
    ? `This Station's host remains at capacity (${observed}${age}). Automatic work is paused; explicit starts may continue with a warning.`
    : `This Station's host is busy (${observed}${age}). Automatic work is paused until the averaged load recovers.`;
}

export function ResourcePostureBannerSource() {
  const { data } = useResourcePostureQuery();
  const kind = data?.kind;

  useEffect(() => {
    if (kind !== 'degraded' && kind !== 'critical') {
      bannerStore.dismiss(RESOURCE_POSTURE_BANNER_ID);
      return;
    }
    bannerStore.present({
      id: RESOURCE_POSTURE_BANNER_ID,
      priority: BANNER_PRIORITY.capabilityFailure,
      tone: kind === 'critical' ? 'error' : 'warning',
      // Shared with Schedule's paused wording (utils/resourcePosture.ts) so
      // the two surfaces cannot disagree about what this posture is called.
      badge: hostPressureBadge(kind),
      message: postureBannerMessage(kind, data ?? {}),
      // Recurring host-pressure state, not a one-off notice: it clears
      // itself the moment posture recovers (the effect above dismisses it),
      // so a persistent dismiss would only hide a later, distinct episode
      // from a user who already accepted this one.
      dismissible: false,
    });
    return () => {
      bannerStore.dismiss(RESOURCE_POSTURE_BANNER_ID);
    };
  }, [kind, data]);

  return null;
}
