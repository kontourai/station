import type {
  NativeDiagnosticSignalAnswer,
  NativeDiagnosticSignaling,
  NativeDiagnosticSignalOpen,
} from '@kontourai/station-connect/native-diagnostic-echo';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from '@kontourai/station-contracts/self-hosted-broker';

export interface NativeRelayBindingDto {
  profileName: string;
  profileRevision: number;
  scope: SelfHostedBrokerNativeScopeV2;
  surface: SelfHostedBrokerNativeClientSurfaceV2;
  trustRevision: number;
  stationId: string;
  enrollmentId: string;
  generation: number;
  signingKey: ApprovedStationConnectionTrust['signingKey'];
}

export interface TauriInvoker {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

const safeInteger = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0;
const exactKeys = (value: unknown, keys: readonly string[]) =>
  typeof value === 'object' &&
  value !== null &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function validateNativeRelayBinding(
  value: NativeRelayBindingDto,
  profileName: string,
  profileRevision: number,
  errorPrefix: string,
): NativeRelayBindingDto {
  if (
    !value ||
    !exactKeys(value, [
      'profileName',
      'profileRevision',
      'scope',
      'surface',
      'trustRevision',
      'stationId',
      'enrollmentId',
      'generation',
      'signingKey',
    ]) ||
    !exactKeys(value.scope, [
      'stationId',
      'enrollmentId',
      'routingGeneration',
    ]) ||
    !exactKeys(value.surface, [
      'kind',
      'appIdentifier',
      'channel',
      'clientInstanceId',
      'keyThumbprint',
    ]) ||
    !exactKeys(value.signingKey, ['kty', 'crv', 'x', 'y']) ||
    value.profileName !== profileName ||
    value.profileRevision !== profileRevision ||
    !safeInteger(value.trustRevision) ||
    !safeInteger(value.generation) ||
    value.stationId !== value.scope?.stationId ||
    value.enrollmentId !== value.scope?.enrollmentId ||
    !safeInteger(value.scope?.routingGeneration) ||
    value.surface?.kind !== 'station-native' ||
    !value.surface.appIdentifier ||
    !['dev', 'stable', 'beta', 'nightly'].includes(value.surface.channel) ||
    !value.surface.clientInstanceId ||
    !value.surface.keyThumbprint ||
    value.signingKey?.kty !== 'EC' ||
    value.signingKey.crv !== 'P-256' ||
    !value.signingKey.x ||
    !value.signingKey.y
  )
    throw new Error(`${errorPrefix}_binding_invalid`);
  return value;
}

const sameTrust = (
  left: ApprovedStationConnectionTrust,
  right: ApprovedStationConnectionTrust,
) =>
  left.stationId === right.stationId &&
  left.enrollmentId === right.enrollmentId &&
  left.generation === right.generation &&
  JSON.stringify(left.signingKey) === JSON.stringify(right.signingKey);

export interface NativeRelaySignalingBridgeOptions {
  readonly bindingCommand: string;
  readonly bindingArguments?: 'request' | 'flat';
  readonly openCommand: string;
  readonly readCommand: string;
  readonly errorPrefix: string;
  readonly profileName: string;
  readonly profileRevision: number;
  readonly invoke: TauriInvoker;
}

export interface NativeRelayTrustOwner {
  current(): ApprovedStationConnectionTrust | null;
  isCurrent(value: ApprovedStationConnectionTrust): boolean;
  recheck(
    value: ApprovedStationConnectionTrust,
    stage: 'checkpoint' | 'before-remote-description',
  ): Promise<boolean>;
}

/** Reads current host-owned routing and signing trust without allocating a peer. */
export async function createNativeRelayBindingOwner(
  options: Pick<
    NativeRelaySignalingBridgeOptions,
    | 'bindingCommand'
    | 'bindingArguments'
    | 'errorPrefix'
    | 'profileName'
    | 'profileRevision'
    | 'invoke'
  >,
): Promise<{ binding: NativeRelayBindingDto; trust: NativeRelayTrustOwner }> {
  const { bindingCommand, errorPrefix, profileName, profileRevision, invoke } =
    options;
  if (!profileName.trim() || !safeInteger(profileRevision))
    throw new Error(`${errorPrefix}_profile_invalid`);
  const request = { profileName, expectedProfileRevision: profileRevision };
  const fetchBinding = async () =>
    validateNativeRelayBinding(
      (await invoke.invoke(
        bindingCommand,
        options.bindingArguments === 'flat' ? request : { request },
      )) as NativeRelayBindingDto,
      profileName,
      profileRevision,
      errorPrefix,
    );
  const initialValue = await fetchBinding();
  const initial = Object.freeze({
    ...initialValue,
    scope: Object.freeze({ ...initialValue.scope }),
    surface: Object.freeze({ ...initialValue.surface }),
    signingKey: Object.freeze({ ...initialValue.signingKey }),
  });
  const trust: ApprovedStationConnectionTrust = Object.freeze({
    stationId: initial.stationId,
    enrollmentId: initial.enrollmentId,
    generation: initial.generation,
    signingKey: Object.freeze({ ...initial.signingKey }),
  });
  let current: ApprovedStationConnectionTrust | null = trust;
  return {
    binding: initial,
    trust: {
      current: () => current,
      isCurrent: (expected) => !!current && sameTrust(current, expected),
      async recheck(
        expected,
        _stage: 'checkpoint' | 'before-remote-description',
      ) {
        try {
          const fresh = await fetchBinding();
          const same =
            fresh.trustRevision === initial.trustRevision &&
            fresh.scope.routingGeneration === initial.scope.routingGeneration &&
            JSON.stringify(fresh.surface) === JSON.stringify(initial.surface) &&
            sameTrust(
              {
                stationId: fresh.stationId,
                enrollmentId: fresh.enrollmentId,
                generation: fresh.generation,
                signingKey: fresh.signingKey,
              },
              expected,
            );
          current = same ? trust : null;
          return same;
        } catch {
          current = null;
          return false;
        }
      },
    },
  };
}

/**
 * Shared host-relay signaling factory for one exact saved-profile revision.
 * Command names and error prefixes are caller-owned; validation, trust
 * rechecking, and receipt parsing are shared so every relay adapter fails
 * closed identically.
 */
export async function createNativeRelaySignalingBridge(
  options: NativeRelaySignalingBridgeOptions,
): Promise<{
  signaling: NativeDiagnosticSignaling;
  trust: NativeRelayTrustOwner;
}> {
  const {
    openCommand,
    readCommand,
    errorPrefix,
    profileName,
    profileRevision,
    invoke,
  } = options;
  const request = { profileName, expectedProfileRevision: profileRevision };
  const { binding: initial, trust } =
    await createNativeRelayBindingOwner(options);
  const signaling: NativeDiagnosticSignaling = Object.freeze({
    scope: Object.freeze({ ...initial.scope }),
    surface: Object.freeze({ ...initial.surface }),
    async open(input: NativeDiagnosticSignalOpen, signal: AbortSignal) {
      signal.throwIfAborted();
      if (
        input.scope !== initial.scope &&
        JSON.stringify(input.scope) !== JSON.stringify(initial.scope)
      )
        throw new Error(`${errorPrefix}_scope_mismatch`);
      if (
        input.surface !== initial.surface &&
        JSON.stringify(input.surface) !== JSON.stringify(initial.surface)
      )
        throw new Error(`${errorPrefix}_surface_mismatch`);
      const receipt = (await invoke.invoke(openCommand, {
        request: {
          ...request,
          nonce: input.nonce,
          offerSdp: input.offerSdp,
        },
      })) as { expiresAt: number };
      signal.throwIfAborted();
      if (!exactKeys(receipt, ['expiresAt']) || !safeInteger(receipt.expiresAt))
        throw new Error(`${errorPrefix}_open_receipt_invalid`);
      return receipt.expiresAt;
    },
    async read(
      input: Parameters<NativeDiagnosticSignaling['read']>[0],
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      if (
        JSON.stringify(input.scope) !== JSON.stringify(initial.scope) ||
        JSON.stringify(input.surface) !== JSON.stringify(initial.surface)
      )
        throw new Error(`${errorPrefix}_binding_mismatch`);
      const answer = (await invoke.invoke(readCommand, {
        request: {
          ...request,
          nonce: input.nonce,
        },
      })) as {
        answerSdp: string | null;
        stationProof: string | null;
        expiresAt: number;
      };
      signal.throwIfAborted();
      if (
        !exactKeys(answer, ['answerSdp', 'stationProof', 'expiresAt']) ||
        !safeInteger(answer.expiresAt) ||
        (answer.answerSdp !== null && typeof answer.answerSdp !== 'string') ||
        (answer.stationProof !== null &&
          typeof answer.stationProof !== 'string')
      )
        throw new Error(`${errorPrefix}_answer_invalid`);
      const value: NativeDiagnosticSignalAnswer = {
        version: 'station-broker-native-connection-answer/v2',
        expiresAt: answer.expiresAt,
        answerSdp: answer.answerSdp,
        stationProof: answer.stationProof,
      };
      return value;
    },
  });
  return {
    signaling,
    trust,
  };
}
