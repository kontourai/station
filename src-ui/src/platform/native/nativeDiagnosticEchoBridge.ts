import type {
  NativeDiagnosticEchoInput,
  NativeDiagnosticSignalAnswer,
  NativeDiagnosticSignaling,
  NativeDiagnosticSignalOpen,
} from '@kontourai/station-connect/native-diagnostic-echo';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import { invokeTauri } from './tauriInvoke';

interface DiagnosticBindingDto {
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

interface TauriInvoker {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

const defaultInvoker: TauriInvoker = {
  invoke: (command, args) => invokeTauri<unknown>(command, args),
};

const safeInteger = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0;
const exactKeys = (value: unknown, keys: readonly string[]) =>
  typeof value === 'object' &&
  value !== null &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function validateBinding(
  value: DiagnosticBindingDto,
  profileName: string,
  profileRevision: number,
): DiagnosticBindingDto {
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
    throw new Error('native_diagnostic_binding_invalid');
  return value;
}

function sameTrust(
  left: ApprovedStationConnectionTrust,
  right: ApprovedStationConnectionTrust,
) {
  return (
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.generation === right.generation &&
    JSON.stringify(left.signingKey) === JSON.stringify(right.signingKey)
  );
}

/**
 * Creates the explicit native diagnostic adapter for one exact saved-profile
 * revision. It is deliberately opt-in and does not mount application traffic.
 */
export async function createNativeDiagnosticEchoBridge(
  profileName: string,
  profileRevision: number,
  invoke: TauriInvoker = defaultInvoker,
): Promise<NativeDiagnosticEchoInput> {
  if (!profileName.trim() || !safeInteger(profileRevision))
    throw new Error('native_diagnostic_profile_invalid');
  const request = { profileName, expectedProfileRevision: profileRevision };
  const initial = validateBinding(
    (await invoke.invoke(
      'station_native_relay_diagnostic_binding',
      request,
    )) as DiagnosticBindingDto,
    profileName,
    profileRevision,
  );
  const trust: ApprovedStationConnectionTrust = Object.freeze({
    stationId: initial.stationId,
    enrollmentId: initial.enrollmentId,
    generation: initial.generation,
    signingKey: Object.freeze({ ...initial.signingKey }),
  });
  let current: ApprovedStationConnectionTrust | null = trust;
  const fetchCurrent = async () =>
    validateBinding(
      (await invoke.invoke(
        'station_native_relay_diagnostic_binding',
        request,
      )) as DiagnosticBindingDto,
      profileName,
      profileRevision,
    );
  const signaling: NativeDiagnosticSignaling = Object.freeze({
    scope: Object.freeze({ ...initial.scope }),
    surface: Object.freeze({ ...initial.surface }),
    async open(input: NativeDiagnosticSignalOpen, signal: AbortSignal) {
      signal.throwIfAborted();
      if (
        input.scope !== initial.scope &&
        JSON.stringify(input.scope) !== JSON.stringify(initial.scope)
      )
        throw new Error('native_diagnostic_scope_mismatch');
      if (
        input.surface !== initial.surface &&
        JSON.stringify(input.surface) !== JSON.stringify(initial.surface)
      )
        throw new Error('native_diagnostic_surface_mismatch');
      const receipt = (await invoke.invoke(
        'station_native_relay_signal_diagnostic_open',
        {
          ...request,
          nonce: input.nonce,
          offerSdp: input.offerSdp,
        },
      )) as { expiresAt: number };
      signal.throwIfAborted();
      if (!safeInteger(receipt?.expiresAt))
        throw new Error('native_diagnostic_open_receipt_invalid');
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
        throw new Error('native_diagnostic_binding_mismatch');
      const answer = (await invoke.invoke(
        'station_native_relay_signal_diagnostic_read',
        {
          ...request,
          nonce: input.nonce,
        },
      )) as {
        answerSdp: string | null;
        stationProof: string | null;
        expiresAt: number;
      };
      signal.throwIfAborted();
      if (
        !answer ||
        !safeInteger(answer.expiresAt) ||
        (answer.answerSdp !== null && typeof answer.answerSdp !== 'string') ||
        (answer.stationProof !== null &&
          typeof answer.stationProof !== 'string')
      )
        throw new Error('native_diagnostic_answer_invalid');
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
    trust: {
      current: () => current,
      isCurrent: (expected) => !!current && sameTrust(current, expected),
      async recheck(
        expected,
        _stage: 'checkpoint' | 'before-remote-description',
      ) {
        try {
          const fresh = await fetchCurrent();
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
