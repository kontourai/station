/**
 * #2228 — the "Reconnect this Station" affordance for the host pairing
 * panel. The desktop's own local-service Station is the one Station whose
 * "needs review" state is never a user problem to solve: the app holds the
 * per-boot owner-secret and can self-provision. This helper is the
 * user-invoked counterpart of OnboardingGate's boot-time attempts — it is
 * deliberately NOT latched (a user who clicks Reconnect twice means it),
 * while the host-side command stays the single authority on whether a mint
 * actually happens.
 */

import { attemptLocalSelfProvision } from '@kontourai/station-connect';
import { nativeProfileRepository } from '../PlatformProfileContext';
import { invokeTauri } from './tauriInvoke';

/**
 * Attempts `station_local_self_provision` for the process-selected local
 * Station. Resolves `false` when there is no local-service profile to
 * provision or the host refused (kept opaque by the connect wrapper) — the
 * panel renders its retry copy in that case. On success the shared saved
 * Station store is re-read so the panel's next poll carries the fresh
 * credential the native command just authorized.
 */
export async function reconnectLocalService(): Promise<boolean> {
  const profileName =
    nativeProfileRepository().pendingLocalSelfProvisionProfileName();
  if (!profileName) return false;
  const provisioned = await attemptLocalSelfProvision({
    invoke: invokeTauri,
    profileName,
  });
  if (provisioned) await nativeProfileRepository().refresh();
  return provisioned;
}
