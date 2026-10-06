import { join } from 'node:path';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import {
  NativeDeviceRequestAuthority,
  type NativeDeviceRequestAuthorityDeps,
} from '../../security/native-device-request-authority.js';
import type { DeploymentAuthenticationService } from '../../services/identity/deployment-authentication-service.js';
import { NativeDeviceProofReplayStoreSqlite } from '../../services/identity/native-device-replay-store.js';
import {
  NativeDeviceProofBindingService,
  type NativeDeviceProofPairingSource,
} from '../../services/ssh/native-device-proof-binding-service.js';

export interface NativeApplicationConnectorConfiguration {
  readonly stationId: string;
  readonly surface?: SelfHostedBrokerNativeClientSurfaceV2;
  readonly registry?: true;
}

export interface NativeDeviceProofRuntime {
  readonly authority: NativeDeviceRequestAuthority;
  readonly bindings: NativeDeviceProofBindingService;
  readonly configuration: NativeDeviceRequestAuthorityDeps;
  close(): void;
}

export function nativeDeviceProofPilotEnabled(
  flag: string | undefined,
): boolean {
  if (flag === undefined || flag === '0') return false;
  if (flag === '1') return true;
  throw new Error('STATION_NATIVE_DEVICE_PROOF_PILOT must be 0 or 1.');
}

/** Trusted runtime composition; configuration never substitutes for private peer provenance. */
export function createNativeDeviceProofRuntime(input: {
  flag: string | undefined;
  homeDir: string;
  stationId: string;
  authentication?: Pick<
    DeploymentAuthenticationService,
    'sessionReferenceCapabilities'
  >;
  virtualApplicationOrigin?: string;
  nativeApplication?: NativeApplicationConnectorConfiguration;
  pairing: NativeDeviceProofPairingSource;
}): NativeDeviceProofRuntime | undefined {
  if (!nativeDeviceProofPilotEnabled(input.flag)) return undefined;
  const capabilities = input.authentication?.sessionReferenceCapabilities();
  if (!capabilities?.verify || !capabilities.login)
    throw new Error(
      'STATION_NATIVE_DEVICE_PROOF_PILOT requires session reference verify and login capabilities.',
    );
  if (
    !input.virtualApplicationOrigin ||
    !input.nativeApplication ||
    input.nativeApplication.stationId !== input.stationId ||
    input.pairing.environmentId() !== input.stationId
  )
    throw new Error(
      'STATION_NATIVE_DEVICE_PROOF_PILOT requires a native application connector for this Station.',
    );
  const replayStore = new NativeDeviceProofReplayStoreSqlite(
    join(input.homeDir, 'security', 'native-device-proof-replay.sqlite'),
    input.stationId,
  );
  try {
    const bindings = new NativeDeviceProofBindingService({
      homeDir: input.homeDir,
      pairing: input.pairing,
    });
    const configuration: NativeDeviceRequestAuthorityDeps = {
      binding: bindings,
      pairing: {
        activeDevice: (deviceId) =>
          input.pairing
            .listDevices()
            .find(
              (device) =>
                device.id === deviceId &&
                device.kind === 'device' &&
                device.revokedAt === null,
            ),
      },
      replayStore,
    };
    const authority = new NativeDeviceRequestAuthority(configuration);
    return {
      authority,
      bindings,
      configuration,
      close() {
        authority.close();
        replayStore.close();
      },
    };
  } catch (error) {
    replayStore.close();
    throw error;
  }
}
