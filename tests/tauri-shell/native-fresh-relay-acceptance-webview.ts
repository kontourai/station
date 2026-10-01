import { isStationProfileStore } from '@kontourai/station-contracts';
import { prepareNativeRelayConnectionOwner } from '../../src-ui/src/platform/native/nativeRelayConnectionOwner';
import { createNativeRelayEnrollmentClient } from '../../src-ui/src/platform/native/nativeRelayEnrollmentClient';
import { nativeStationProfileStorage } from '../../src-ui/src/platform/native/stationProfileStorage';
import { invokeTauri } from '../../src-ui/src/platform/native/tauriInvoke';

/** Harness seam for an actual main WebView. Every authority/crypto operation uses the production default native host. */
export function createNativeFreshRelayAcceptance(input: {
  profileName: string;
  profileRevision: number;
  stationAudience: string;
}) {
  const controller = new AbortController();
  const enrollment = createNativeRelayEnrollmentClient({
    profileName: input.profileName,
    expectedProfileRevision: input.profileRevision,
    stationAudience: input.stationAudience,
    signal: controller.signal,
  });
  return Object.freeze({
    begin: enrollment.begin,
    register: (
      credentials: { username: string; password: string },
      invitation: string,
      name: string,
    ) => enrollment.login(credentials, { invitation, name }),
    login: enrollment.login,
    finalize: enrollment.finalize,
    activate: enrollment.activate,
    status: enrollment.status,
    cancel: enrollment.cancel,
    recovery: enrollment.recovery,
    resume: enrollment.resume,
    async accountOwner() {
      const storage = nativeStationProfileStorage(true);
      await storage.refresh();
      const profile = storage
        .getRelayRouteProfiles()
        .find((value) => value.name === input.profileName);
      if (!profile?.relayRoute || profile.configurationState !== 'configured')
        throw new Error('native_fixture_owned_activation_required');
      const connectionId = `station-profile:${profile.name.toLowerCase()}`;
      if (!(await storage.authorizeActiveConnection(connectionId, true)))
        throw new Error('native_fixture_selection_refused');
      const binding = storage.captureNativeRequestBinding(
        connectionId,
        input.stationAudience,
      );
      if (!binding) throw new Error('native_fixture_binding_required');
      const rawStore = await invokeTauri<unknown>('station_profile_store_read');
      const store: unknown =
        typeof rawStore === 'string' ? JSON.parse(rawStore) : rawStore;
      if (!isStationProfileStore(store))
        throw new Error('native_fixture_profile_store_invalid');
      const route = {
        routeVersion: 1 as const,
        brokerOrigin: profile.relayRoute.brokerOrigin,
        profileName: profile.name,
        profileRevision: store.revision,
        stationId: profile.relayRoute.stationId,
        enrollmentId: profile.relayRoute.enrollmentId,
      };
      return prepareNativeRelayConnectionOwner({
        connectionId,
        origin: input.stationAudience,
        route,
        bindingId: binding.bindingId,
        selectionIsCurrent: () =>
          !controller.signal.aborted &&
          storage.captureNativeRequestBinding(
            connectionId,
            input.stationAudience,
          )?.bindingId === binding.bindingId,
      });
    },
    async stop() {
      controller.abort();
      await enrollment.dispose();
    },
  });
}
