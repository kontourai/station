/**
 * The ONE owner that turns a verified native Device request proof into a
 * credential-free Request principal, and re-derives that principal's
 * currentness for every later seam (account-bound gate, orchestration
 * principal, Project membership, native account continuation).
 *
 * Selector lookups are hints: every authority decision here re-reads the
 * binding service and the real pairing owner. The audience and peer nonce in
 * the verified binding snapshot come ONLY from the private Pion peer facts
 * carried on the Request — never from any header, body field or claim source
 * other than the proof's own signature check against those facts.
 */
import type {
  DevicePrincipalBinding,
  PairedDevice,
} from '@kontourai/station-contracts/environment-security';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { readVerifiedNativeVirtualApplicationRequest } from '../services/connections/virtual-application.js';
import {
  NativeDeviceProofRejectedError,
  NativeDeviceProofReplayedError,
  type NativeDeviceProofReplayStore,
  verifyNativeDeviceRequestProof,
} from '../services/identity/native-device-proof-verifier.js';
import {
  getRuntimeNativeDeviceProofPrincipal,
  isRuntimeNativeDeviceProofCurrent,
  setRuntimeNativeDeviceProofPrincipal,
} from './runtime-request-security.js';

/** Exact current-binding lookup shape of `NativeDeviceProofBindingService`. */
export interface NativeDeviceProofBindingLookup {
  currentBinding(input: {
    deviceId: string;
    surface: SelfHostedBrokerNativeClientSurfaceV2;
  }): {
    binding: {
      readonly bindingId: string;
      readonly deviceId: string;
      readonly stationId: string;
      readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
      readonly deviceProof: {
        readonly jwk: {
          readonly kty: 'EC';
          readonly crv: 'P-256';
          readonly x: string;
          readonly y: string;
        };
        readonly thumbprint: string;
      };
    };
    device: { readonly id: string; readonly scope: string };
  } | null;
}

/** Full current paired-Device lookup owned by the real pairing service. */
export interface NativeDeviceProofPairingLookup {
  activeDevice(deviceId: string): PairedDevice | undefined;
}

export interface NativeDeviceRequestAuthorityDeps {
  readonly binding: NativeDeviceProofBindingLookup;
  readonly pairing: NativeDeviceProofPairingLookup;
  readonly replayStore: NativeDeviceProofReplayStore;
  readonly nowSeconds?: () => number;
}

export type NativeDeviceRequestRefusalCode =
  | 'provenance_invalid'
  | 'binding_not_current'
  | 'device_not_current'
  | 'account_binding_required'
  | 'proof_invalid'
  | 'proof_replayed';

export class NativeDeviceRequestRefusedError extends Error {
  constructor(
    readonly code: NativeDeviceRequestRefusalCode,
    options?: { cause?: unknown },
  ) {
    super(`Native Device request refused (${code}).`, options);
    this.name = 'NativeDeviceRequestRefusedError';
  }
}

export interface NativeDeviceAdmissionInput {
  readonly proof: string;
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array;
}

export interface NativeDeviceAdmission {
  readonly deviceId: string;
  readonly bindingId: string;
  readonly scope: string;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
}

export interface NativeDeviceCurrentRequest {
  readonly deviceId: string;
  readonly bindingId: string;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly device: PairedDevice;
  readonly accountBinding: Extract<DevicePrincipalBinding, { kind: 'account' }>;
}

const accountBindingOf = (
  device: Pick<PairedDevice, 'principalBinding'>,
): Extract<DevicePrincipalBinding, { kind: 'account' }> | undefined => {
  const binding = device.principalBinding;
  return binding && 'kind' in binding && binding.kind === 'account'
    ? binding
    : undefined;
};

export class NativeDeviceRequestAuthority {
  constructor(private readonly deps: NativeDeviceRequestAuthorityDeps) {}

  /**
   * Verify one Device request JWS against the exact received bytes and the
   * private Pion peer facts already carried on `finalRequest`, then mint the
   * credential-free native principal on that same Request. Throws
   * {@link NativeDeviceRequestRefusedError} on any refusal; the JTI is
   * consumed exactly once by the verifier and never by a currentness recheck.
   */
  async admit(
    finalRequest: Request,
    input: NativeDeviceAdmissionInput,
  ): Promise<NativeDeviceAdmission> {
    const facts = readVerifiedNativeVirtualApplicationRequest(finalRequest);
    if (!facts) throw new NativeDeviceRequestRefusedError('provenance_invalid');
    let verification: Awaited<
      ReturnType<typeof verifyNativeDeviceRequestProof>
    >;
    try {
      verification = await verifyNativeDeviceRequestProof(
        input.proof,
        { method: input.method, path: input.path, body: input.body },
        {
          binding: async (selectors) => {
            const current = this.deps.binding.currentBinding({
              deviceId: selectors.deviceId,
              surface: facts.surface,
            });
            if (!current || current.binding.bindingId !== selectors.bindingId)
              return { status: 'revoked' as const };
            return {
              status: 'approved' as const,
              snapshot: {
                stationId: current.binding.stationId,
                // Audience and peer nonce are private Pion facts only.
                stationAudience: facts.requestOrigin,
                deviceId: current.binding.deviceId,
                bindingId: current.binding.bindingId,
                deviceProofKeyThumbprint:
                  current.binding.deviceProof.thumbprint,
                peerNonce: facts.peerNonce,
                surface: current.binding.surface,
              },
              deviceProofKey: current.binding.deviceProof.jwk,
            };
          },
          peer: async () => ({
            status: facts.isCurrent()
              ? ('current' as const)
              : ('aborted' as const),
            snapshot: {
              stationId: facts.stationId,
              stationAudience: facts.requestOrigin,
              surface: facts.surface,
              peerNonce: facts.peerNonce,
            },
          }),
        },
        {
          replayStore: this.deps.replayStore,
          nowSeconds: this.deps.nowSeconds,
        },
      );
    } catch (cause) {
      if (cause instanceof NativeDeviceProofReplayedError)
        throw new NativeDeviceRequestRefusedError('proof_replayed', { cause });
      if (cause instanceof NativeDeviceProofRejectedError)
        throw new NativeDeviceRequestRefusedError('proof_invalid', { cause });
      throw cause;
    }
    const minted = this.mint(finalRequest, {
      deviceId: verification.deviceId,
      bindingId: verification.bindingId,
      surface: facts.surface,
    });
    return {
      deviceId: minted.deviceId,
      bindingId: minted.bindingId,
      scope: minted.device.scope,
      surface: facts.surface,
    };
  }

  /**
   * The shared current-Device resolver. Returns `undefined` for every
   * request that does not currently carry a proven native authority whose
   * binding, paired Device (`kind: 'device'`) and account binding are all
   * still current — re-read now, never carried from headers.
   */
  resolveCurrent(request: Request): NativeDeviceCurrentRequest | undefined {
    const principal = getRuntimeNativeDeviceProofPrincipal(request);
    if (!principal || !isRuntimeNativeDeviceProofCurrent(request))
      return undefined;
    return this.currentFor(
      principal.deviceId,
      principal.bindingId,
      principal.approvedSurface,
    );
  }

  private mint(
    finalRequest: Request,
    selectors: {
      deviceId: string;
      bindingId: string;
      surface: SelfHostedBrokerNativeClientSurfaceV2;
    },
  ): NativeDeviceCurrentRequest {
    const current = this.currentFor(
      selectors.deviceId,
      selectors.bindingId,
      selectors.surface,
    );
    if (!current) {
      throw new NativeDeviceRequestRefusedError(
        this.deps.pairing.activeDevice(selectors.deviceId)
          ? 'account_binding_required'
          : 'device_not_current',
      );
    }
    setRuntimeNativeDeviceProofPrincipal(finalRequest, {
      kind: 'native-device-proof',
      deviceId: current.deviceId,
      bindingId: current.bindingId,
      approvedSurface: current.surface,
      isCurrent: () =>
        this.currentFor(
          current.deviceId,
          current.bindingId,
          current.surface,
        ) !== undefined,
    });
    return current;
  }

  private currentFor(
    deviceId: string,
    bindingId: string,
    surface: SelfHostedBrokerNativeClientSurfaceV2,
  ): NativeDeviceCurrentRequest | undefined {
    const current = this.deps.binding.currentBinding({ deviceId, surface });
    if (!current || current.binding.bindingId !== bindingId) return undefined;
    const device = this.deps.pairing.activeDevice(deviceId);
    if (device?.kind !== 'device') return undefined;
    const accountBinding = accountBindingOf(device);
    if (!accountBinding) return undefined;
    return {
      deviceId,
      bindingId,
      surface,
      device,
      accountBinding,
    };
  }
}
