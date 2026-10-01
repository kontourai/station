import { createNativeEnrollmentExchange } from '@kontourai/station-connect/native-enrollment';
import {
  NATIVE_RELAY_ENROLLMENT_PATHS,
  NATIVE_RELAY_ENROLLMENT_VERSION,
  type NativeRelayEnrollmentHostActivationAccepted,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { z } from 'zod/v3';
import { createNativeEnrollmentSignalingBridge } from './nativeEnrollmentSignalingBridge';
import type { TauriInvoker } from './nativeRelaySignalingBridge';

const handle = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const version = z.literal(NATIVE_RELAY_ENROLLMENT_VERSION);
const surface = z
  .object({
    kind: z.literal('station-native'),
    appIdentifier: z.string().min(1).max(256),
    channel: z.enum(['dev', 'stable', 'beta', 'nightly']),
    clientInstanceId: z.string().uuid(),
    keyThumbprint: handle,
  })
  .strict();
const publicKey = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: handle,
    y: handle,
  })
  .strict();
const candidate = z
  .object({
    version: z.literal('station-native-device-binding-candidate/v1'),
    stationId: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(128),
    bindingId: z.string().uuid(),
    surface,
    deviceProofJwk: publicKey,
    deviceProofKeyThumbprint: handle,
  })
  .strict();
const challenge = z
  .object({
    version,
    enrollmentHandle: handle,
    candidate,
    registrationAvailable: z.boolean(),
  })
  .strict();
const inactive = z
  .object({
    version,
    enrollmentHandle: handle,
    state: z.enum(['pending', 'cancelled', 'expired', 'revoked']),
  })
  .strict();
const staged = z
  .object({
    version,
    enrollmentHandle: handle,
    state: z.literal('staged'),
  })
  .strict();
const active = z
  .object({
    version,
    enrollmentHandle: handle,
    state: z.literal('active'),
    profileRevision: revision,
    transitionHandle: handle,
  })
  .strict();
const recoveredAttempt = z
  .object({
    enrollmentHandle: handle,
    phase: z.enum([
      'begin-required',
      'candidate',
      'staged',
      'activation-unknown',
      'active',
      'cancel-required',
    ]),
    profileRevision: revision,
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    registrationAvailable: z.boolean(),
    candidate: candidate.nullable(),
    transition: active.nullable(),
  })
  .strict();
const recovery = z
  .object({ version, attempts: z.array(recoveredAttempt).max(16) })
  .strict();
const prepared = z
  .object({
    version: z.literal('station-native-enrollment-request/v1'),
    requestHandle: handle,
    peerHandle: handle,
    enrollmentHandle: handle.optional(),
    method: z.literal('POST'),
    path: z.enum(NATIVE_RELAY_ENROLLMENT_PATHS),
    headers: z
      .object({ 'Content-Type': z.literal('application/json') })
      .strict(),
    body: z.string(),
  })
  .strict();

export interface NativeRelayEnrollmentClientInput {
  readonly profileName: string;
  readonly expectedProfileRevision: number;
  readonly stationAudience: string;
  readonly signal: AbortSignal;
  readonly invoke: TauriInvoker;
}

/** Fixed host operations own signing, sealed custody, activation and recovery. */
export function createNativeRelayEnrollmentClient(
  input: NativeRelayEnrollmentClientInput,
) {
  const profileName = input.profileName;
  const stationAudience = input.stationAudience;
  const signal = input.signal;
  const invoke = input.invoke;
  let profileRevision = input.expectedProfileRevision;
  let enrollmentHandle: string | undefined;
  let busy = false;
  let completed = false;
  let pendingPublication:
    | NativeRelayEnrollmentHostActivationAccepted
    | undefined;

  const abortOwned = async () => {
    if (completed) return;
    if (enrollmentHandle)
      await invoke.invoke('station_native_enrollment_abort', {
        enrollmentHandle,
      });
  };
  const requireHandle = () => {
    if (!enrollmentHandle) throw new Error('native_enrollment_not_started');
    return enrollmentHandle;
  };
  const assertTransition = async (
    value: NativeRelayEnrollmentHostActivationAccepted,
  ) => {
    const current = active.parse(
      await invoke.invoke('station_native_enrollment_transition_current', {
        enrollmentHandle: value.enrollmentHandle,
        transitionHandle: value.transitionHandle,
        expectedProfileRevision: value.profileRevision,
      }),
    );
    if (
      current.enrollmentHandle !== value.enrollmentHandle ||
      current.transitionHandle !== value.transitionHandle ||
      current.profileRevision !== value.profileRevision
    )
      throw new Error('native_enrollment_transition_retired');
  };

  const operation = async <T>(
    prepareCommand: string,
    args: Record<string, unknown>,
    accept: (requestHandle: string, response: unknown) => Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    if (busy) throw new Error('native_enrollment_operation_pending');
    busy = true;
    let publication: NativeRelayEnrollmentHostActivationAccepted | undefined;
    try {
      if (pendingPublication) {
        await assertTransition(pendingPublication);
        completed = true;
        profileRevision = pendingPublication.profileRevision;
        pendingPublication = undefined;
      }
      const bridge = createNativeEnrollmentSignalingBridge({
        profileName,
        expectedProfileRevision: profileRevision,
        stationAudience,
        signal,
        invoke,
      });
      const exchange = createNativeEnrollmentExchange({
        signal,
        async open(peerSignal) {
          const opened = await bridge.open(peerSignal);
          return {
            ...opened,
            assertCurrent: () =>
              publication
                ? assertTransition(publication)
                : opened.assertCurrent(),
          };
        },
      });
      const outcome = await exchange(
        async (peerHandle) => {
          const frame = prepared.parse(
            await invoke.invoke(prepareCommand, { ...args, peerHandle }),
          );
          if (frame.enrollmentHandle) {
            if (enrollmentHandle && frame.enrollmentHandle !== enrollmentHandle)
              throw new Error('native_enrollment_attempt_changed');
            enrollmentHandle = frame.enrollmentHandle;
          }
          if (signal.aborted) {
            await abortOwned();
            signal.throwIfAborted();
          }
          return frame;
        },
        async (requestHandle, response) => {
          const result = await accept(requestHandle, response);
          if (
            typeof result === 'object' &&
            result !== null &&
            'state' in result &&
            result.state === 'active'
          ) {
            const owned = active.parse(result);
            if (owned.enrollmentHandle !== requireHandle())
              throw new Error('native_enrollment_attempt_changed');
            pendingPublication = owned;
            await assertTransition(owned);
            completed = true;
            publication = owned;
            profileRevision = owned.profileRevision;
            pendingPublication = undefined;
          }
          if (signal.aborted) {
            await abortOwned();
            signal.throwIfAborted();
          }
          return result;
        },
      );
      if (publication) completed = true;
      return outcome;
    } finally {
      busy = false;
    }
  };
  const acceptState = async (
    command: string,
    requestHandle: string,
    response: unknown,
  ) => {
    const result = z
      .union([active, inactive])
      .parse(await invoke.invoke(command, { requestHandle, response }));
    if (result.enrollmentHandle !== requireHandle())
      throw new Error('native_enrollment_attempt_changed');
    return result;
  };

  const recoveryProjection = async () => {
    signal.throwIfAborted();
    const projection = recovery.parse(
      await invoke.invoke('station_native_enrollment_resume', {
        profileName,
        expectedProfileRevision: profileRevision,
      }),
    );
    signal.throwIfAborted();
    for (const attempt of projection.attempts) {
      if (
        attempt.profileRevision !== profileRevision ||
        (attempt.phase === 'active') !== (attempt.transition !== null) ||
        (attempt.transition &&
          (attempt.transition.enrollmentHandle !== attempt.enrollmentHandle ||
            attempt.transition.profileRevision !== attempt.profileRevision))
      )
        throw new Error('native_enrollment_recovery_invalid');
    }
    return projection;
  };

  return Object.freeze({
    recovery: recoveryProjection,
    resume: async (selectedHandle: string) => {
      signal.throwIfAborted();
      if (busy) throw new Error('native_enrollment_operation_pending');
      busy = true;
      try {
        const projection = await recoveryProjection();
        const attempt = projection.attempts.find(
          (value) => value.enrollmentHandle === selectedHandle,
        );
        if (
          !attempt ||
          (attempt.phase !== 'active' && attempt.expiresAt <= Date.now())
        )
          throw new Error('native_enrollment_recovery_invalid');
        if (enrollmentHandle && enrollmentHandle !== attempt.enrollmentHandle)
          throw new Error('native_enrollment_attempt_changed');
        enrollmentHandle = attempt.enrollmentHandle;
        if (attempt.transition) {
          pendingPublication = attempt.transition;
          await assertTransition(attempt.transition);
          signal.throwIfAborted();
          completed = true;
          profileRevision = attempt.transition.profileRevision;
          pendingPublication = undefined;
        }
        return attempt;
      } finally {
        busy = false;
      }
    },
    begin: () =>
      operation(
        'station_native_enrollment_begin_prepare',
        enrollmentHandle ? { enrollmentHandle } : {},
        async (requestHandle, response) => {
          const result = challenge.parse(
            await invoke.invoke('station_native_enrollment_challenge_accept', {
              requestHandle,
              response,
            }),
          );
          if (result.enrollmentHandle !== requireHandle())
            throw new Error('native_enrollment_attempt_changed');
          return result;
        },
      ),
    login: (
      credentials: { username: string; password: string },
      registration?: { invitation: string; name?: string },
    ) =>
      operation(
        'station_native_enrollment_login_prepare',
        {
          enrollmentHandle: requireHandle(),
          credentials: { ...credentials },
          ...(registration ? { ...registration } : {}),
        },
        async (requestHandle, response) => {
          const result = inactive.parse(
            await invoke.invoke('station_native_enrollment_pending_accept', {
              requestHandle,
              response,
            }),
          );
          if (
            result.enrollmentHandle !== requireHandle() ||
            result.state !== 'pending'
          )
            throw new Error('native_enrollment_attempt_changed');
          return result;
        },
      ),
    finalize: () =>
      operation(
        'station_native_enrollment_finalize_prepare',
        { enrollmentHandle: requireHandle() },
        async (requestHandle, response) => {
          const pending =
            typeof response === 'object' &&
            response !== null &&
            'state' in response &&
            response.state === 'pending';
          const result = pending
            ? inactive.parse(
                await invoke.invoke(
                  'station_native_enrollment_pending_accept',
                  { requestHandle, response },
                ),
              )
            : staged.parse(
                await invoke.invoke(
                  'station_native_enrollment_delivery_accept',
                  { requestHandle, response },
                ),
              );
          if (result.enrollmentHandle !== requireHandle())
            throw new Error('native_enrollment_attempt_changed');
          return result;
        },
      ),
    activate: () =>
      operation(
        'station_native_enrollment_activate_prepare',
        { enrollmentHandle: requireHandle() },
        (requestHandle, response) =>
          acceptState(
            'station_native_enrollment_activation_accept',
            requestHandle,
            response,
          ),
      ),
    status: () =>
      operation(
        'station_native_enrollment_status_prepare',
        { enrollmentHandle: requireHandle() },
        (requestHandle, response) =>
          acceptState(
            'station_native_enrollment_status_accept',
            requestHandle,
            response,
          ),
      ),
    cancel: () =>
      operation(
        'station_native_enrollment_cancel_prepare',
        { enrollmentHandle: requireHandle() },
        (requestHandle, response) =>
          acceptState(
            'station_native_enrollment_status_accept',
            requestHandle,
            response,
          ),
      ),
    abort: abortOwned,
    dispose: async () => {
      if (!pendingPublication) await abortOwned();
    },
  });
}
