import { parseRelayIceConfiguration } from '@kontourai/station-connect/relay-ice';
import { type RelayIceConfigurationV1 } from '@kontourai/station-contracts/relay-ice';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import { invokeTauri } from './tauriInvoke';

export interface NativeRelayIceConfigurationInput {
  readonly profileName: string;
  readonly expectedProfileRevision: number;
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly peerDeadline: number;
  readonly signal: AbortSignal;
}

export interface NativeRelayIceConfigurationResult {
  readonly configuration: RTCConfiguration & {
    readonly iceTransportPolicy: 'relay';
  };
  readonly expiresAt: number;
}

export interface NativeRelayIceConfigurationBridge {
  get(
    input: NativeRelayIceConfigurationInput,
  ): Promise<NativeRelayIceConfigurationResult>;
}

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const ICE_CONFIGURATION_COMMAND = 'station_native_relay_ice_configuration';

function safeRtcConfiguration(
  ice: RelayIceConfigurationV1,
): NativeRelayIceConfigurationResult['configuration'] {
  return {
    iceTransportPolicy: 'relay',
    iceServers: ice.iceServers.map((server) => ({
      urls: [...server.urls],
      username: server.username,
      credential: server.credential,
    })),
  };
}

export function createNativeRelayIceConfigurationBridge(
  invoke: Invoke = (command, args) => invokeTauri<unknown>(command, args),
  now: () => number = Date.now,
): NativeRelayIceConfigurationBridge {
  return {
    async get(input) {
      const profileName = input.profileName;
      const expectedProfileRevision = input.expectedProfileRevision;
      const peerDeadline = input.peerDeadline;
      const signal = input.signal;
      const scope = Object.freeze({
        stationId: input.scope.stationId,
        enrollmentId: input.scope.enrollmentId,
        routingGeneration: input.scope.routingGeneration,
      });
      const surface = Object.freeze({
        kind: input.surface.kind,
        appIdentifier: input.surface.appIdentifier,
        channel: input.surface.channel,
        clientInstanceId: input.surface.clientInstanceId,
        keyThumbprint: input.surface.keyThumbprint,
      });

      signal.throwIfAborted();
      const currentTime = now();
      if (
        !profileName.trim() ||
        profileName.length > 256 ||
        !Number.isSafeInteger(expectedProfileRevision) ||
        expectedProfileRevision < 1 ||
        !Number.isSafeInteger(peerDeadline) ||
        peerDeadline <= currentTime
      ) {
        throw new Error('native_relay_ice_request_invalid');
      }

      const response = await invoke(ICE_CONFIGURATION_COMMAND, {
        profileName,
        expectedProfileRevision,
      });
      signal.throwIfAborted();

      const configuration = parseRelayIceConfiguration(
        response,
        { scope, surface },
        now(),
      );
      if (configuration.expiresAt <= peerDeadline)
        throw new Error('native_relay_ice_peer_deadline_uncovered');

      return {
        configuration: safeRtcConfiguration(configuration),
        expiresAt: configuration.expiresAt,
      };
    },
  };
}
