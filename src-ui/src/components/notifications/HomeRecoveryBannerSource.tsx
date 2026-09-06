import { useConnections } from '@kontourai/station-connect';
import { useSystemStatusForApiBaseQuery } from '@kontourai/station-sdk';
import { useEffect } from 'react';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../../contexts/banner-store';

/** Uses the existing host-scoped query and banner host; no separate fetch loop. */
export function HomeRecoveryBannerSource() {
  const { apiBase } = useConnections();
  const query = useSystemStatusForApiBaseQuery(apiBase);
  const recovery =
    query.isFetchedAfterMount && !query.isError
      ? query.data?.homeRecovery
      : undefined;
  useEffect(() => {
    bannerStore.clear(BANNER_IDS.homeRecovery);
    if (!recovery || recovery.kind === 'not-restored') return;
    if (recovery.kind === 'unavailable') {
      bannerStore.present({
        id: BANNER_IDS.homeRecovery,
        priority: BANNER_PRIORITY.setup,
        tone: 'warning',
        badge: 'Recovery status',
        dismissible: false,
        message: 'This Station’s recovery record could not be verified.',
        detail:
          'Check the recovered home before resuming work. This notice does not establish execution ownership.',
      });
    } else if (
      recovery.kind === 'recovered-from-copy' &&
      recovery.authorityTransferred === false &&
      typeof recovery.recoveryId === 'string' &&
      typeof recovery.snapshotCreatedAt === 'string' &&
      !Number.isNaN(Date.parse(recovery.snapshotCreatedAt))
    ) {
      bannerStore.present({
        id: BANNER_IDS.homeRecovery,
        occurrence: `${apiBase}:${recovery.recoveryId}`,
        priority: BANNER_PRIORITY.setup,
        tone: 'warning',
        badge: 'Recovered copy',
        dismissible: false,
        message: `Recovered from a copy saved ${new Date(recovery.snapshotCreatedAt).toLocaleString()}.`,
        detail:
          'Work after that snapshot may be missing. Restoring this copy did not transfer execution authority.',
      });
    }
    return () => bannerStore.clear(BANNER_IDS.homeRecovery);
  }, [apiBase, recovery]);
  return null;
}
