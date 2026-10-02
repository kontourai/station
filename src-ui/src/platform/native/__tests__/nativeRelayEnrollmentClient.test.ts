// @vitest-environment node

import {
  type ApplicationChannel,
  serveApplicationChannel,
} from '@kontourai/station-connect/application-channel';
import { nativeEnrollmentFailureDiagnostic } from '@kontourai/station-connect/native-enrollment';
import {
  NATIVE_RELAY_ENROLLMENT_BASE_PATH,
  NATIVE_RELAY_ENROLLMENT_VERSION,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { beforeEach, expect, test, vi } from 'vitest';
import { createNativeRelayEnrollmentClient } from '../nativeRelayEnrollmentClient';

const transport = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../nativeEnrollmentSignalingBridge', () => ({
  createNativeEnrollmentSignalingBridge: (input: {
    expectedProfileRevision: number;
  }) => ({
    open: (signal: AbortSignal) =>
      transport.open(input.expectedProfileRevision, signal),
  }),
}));
const ORIGIN = 'https://station.example';
const ENROLLMENT = 'e'.repeat(43);
const TRANSITION = 't'.repeat(43);
const VERSION = NATIVE_RELAY_ENROLLMENT_VERSION;

beforeEach(() => vi.clearAllMocks());

function fixture(
  options: { status?: number; challengeFailure?: unknown } = {},
) {
  const lifetime = new AbortController();
  let liveRevision = 7;
  let peerSequence = 0;
  let failTransition = false;
  let failOpen = false;
  const openedRevisions: number[] = [];
  const requests: { path: string; body: string }[] = [];
  transport.open.mockImplementation(async (capturedRevision: number) => {
    openedRevisions.push(capturedRevision);
    if (failOpen) {
      failOpen = false;
      throw new Error('ice_unavailable');
    }
    const listeners: Array<
      { message: (value: unknown) => void; closed: () => void } | undefined
    > = [];
    let closed = false;
    const pair = [0, 1].map(
      (side): ApplicationChannel => ({
        send(value) {
          queueMicrotask(() => {
            if (!closed) listeners[1 - side]?.message(value);
          });
        },
        close() {
          if (closed) return;
          closed = true;
          queueMicrotask(() =>
            listeners.forEach((listener) => listener?.closed()),
          );
        },
        subscribe(message, onClosed) {
          listeners[side] = { message, closed: onClosed };
          return () => {
            listeners[side] = undefined;
          };
        },
      }),
    );
    serveApplicationChannel(pair[1]!, ORIGIN, {
      signal: lifetime.signal,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        requests.push({ path, body: await request.text() });
        return Response.json(
          {
            state: path.endsWith('/login') ? 'pending' : 'response',
            path,
          },
          { status: options.status ?? 200 },
        );
      },
    });
    return {
      peer: {
        peerHandle: String.fromCharCode(65 + peerSequence++).repeat(43),
        stationAudience: ORIGIN,
        expiresAt: Date.now() + 30_000,
      },
      channel: pair[0]!,
      assertCurrent: async () => {
        if (liveRevision !== capturedRevision)
          throw new Error('old_profile_revision');
      },
      close: async () => pair[0]!.close(),
    };
  });
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command.endsWith('_prepare')) {
        const purpose = command
          .replace('station_native_enrollment_', '')
          .replace('_prepare', '');
        return {
          version: 'station-native-enrollment-request/v1',
          requestHandle: 'r'.repeat(43),
          peerHandle: args?.peerHandle,
          enrollmentHandle: ENROLLMENT,
          method: 'POST',
          path: `${NATIVE_RELAY_ENROLLMENT_BASE_PATH}/${purpose}`,
          headers: { 'Content-Type': 'application/json' },
          body: '{"host":"exact"}',
        };
      }
      if (
        command.endsWith('_challenge_accept') &&
        options.challengeFailure !== undefined
      )
        throw options.challengeFailure;
      if (command.endsWith('_challenge_accept'))
        return {
          version: VERSION,
          enrollmentHandle: ENROLLMENT,
          registrationAvailable: true,
          candidate: {
            version: 'station-native-device-binding-candidate/v1',
            stationId: 'station-a',
            deviceId: 'device-a',
            bindingId: '11111111-1111-4111-8111-111111111111',
            surface: {
              kind: 'station-native',
              appIdentifier: 'io.station.test',
              channel: 'dev',
              clientInstanceId: '22222222-2222-4222-8222-222222222222',
              keyThumbprint: 'k'.repeat(43),
            },
            deviceProofJwk: {
              kty: 'EC',
              crv: 'P-256',
              x: 'x'.repeat(43),
              y: 'y'.repeat(43),
            },
            deviceProofKeyThumbprint: 'd'.repeat(43),
          },
        };
      if (command.endsWith('_pending_accept'))
        return {
          version: VERSION,
          enrollmentHandle: ENROLLMENT,
          state: 'pending',
        };
      if (command.endsWith('_delivery_accept'))
        return {
          version: VERSION,
          enrollmentHandle: ENROLLMENT,
          state: 'staged',
        };
      if (command.endsWith('_activation_accept')) {
        liveRevision = 8;
        return {
          version: VERSION,
          enrollmentHandle: ENROLLMENT,
          state: 'active',
          profileRevision: 8,
          transitionHandle: TRANSITION,
        };
      }
      if (command.endsWith('_transition_current')) {
        if (failTransition) {
          failTransition = false;
          throw new Error('transition_ipc_unavailable');
        }
        if (
          args?.enrollmentHandle !== ENROLLMENT ||
          args.transitionHandle !== TRANSITION ||
          args.expectedProfileRevision !== liveRevision
        )
          throw new Error('transition_retired');
        return {
          version: VERSION,
          enrollmentHandle: ENROLLMENT,
          state: 'active',
          profileRevision: liveRevision,
          transitionHandle: TRANSITION,
        };
      }
      if (command.endsWith('_status_accept'))
        return {
          version: VERSION,
          enrollmentHandle: ENROLLMENT,
          state: 'active',
          profileRevision: liveRevision,
          transitionHandle: TRANSITION,
        };
      if (command === 'station_native_enrollment_resume')
        return {
          version: VERSION,
          attempts: [
            {
              enrollmentHandle: ENROLLMENT,
              phase: 'active',
              profileRevision: liveRevision,
              expiresAt: Date.now() + 30_000,
              registrationAvailable: true,
              candidate: null,
              transition: {
                version: VERSION,
                enrollmentHandle: ENROLLMENT,
                state: 'active',
                profileRevision: liveRevision,
                transitionHandle: TRANSITION,
              },
            },
          ],
        };
      if (command.endsWith('_abort')) return;
      throw new Error(`Unexpected fixed host command: ${command}`);
    },
  );
  return {
    client: createNativeRelayEnrollmentClient({
      profileName: 'Pilot',
      expectedProfileRevision: 7,
      stationAudience: ORIGIN,
      signal: lifetime.signal,
      invoke: { invoke },
    }),
    calls,
    requests,
    lifetime,
    openedRevisions,
    failNextTransition: () => {
      failTransition = true;
    },
    failNextOpen: () => {
      failOpen = true;
    },
    recreatedClient: () =>
      createNativeRelayEnrollmentClient({
        profileName: 'Pilot',
        expectedProfileRevision: liveRevision,
        stationAudience: ORIGIN,
        signal: lifetime.signal,
        invoke: { invoke },
      }),
  };
}

test('uses prepared host bytes and keeps successful owned publication through UI cleanup', async () => {
  const f = fixture();
  await f.client.begin();
  await f.client.login({ username: 'zach', password: 'user-entered' });
  await f.client.finalize();
  const result = await f.client.activate();
  expect(result).toMatchObject({ state: 'active', profileRevision: 8 });
  expect(f.requests.map((request) => request.body)).toEqual(
    Array(4).fill('{"host":"exact"}'),
  );
  expect(
    f.calls
      .filter((call) => call.command.endsWith('_accept'))
      .every((call) => call.args?.requestHandle === 'r'.repeat(43)),
  ).toBe(true);
  expect(
    f.calls.some((call) => call.command.endsWith('_transition_current')),
  ).toBe(true);
  await f.client.abort();
  expect(f.calls.some((call) => call.command.endsWith('_abort'))).toBe(false);
});

test('explicit cancellation before completed publication invalidates the actual host attempt', async () => {
  const f = fixture();
  await f.client.begin();
  await f.client.abort();
  expect(f.calls.find((call) => call.command.endsWith('_abort'))?.args).toEqual(
    { enrollmentHandle: ENROLLMENT },
  );
});

test('revalidates an unknown owned publication before opening a recovery peer', async () => {
  const f = fixture();
  await f.client.begin();
  await f.client.login({ username: 'zach', password: 'user-entered' });
  await f.client.finalize();
  f.failNextTransition();
  await expect(f.client.activate()).rejects.toThrow(
    'transition_ipc_unavailable',
  );
  await f.client.dispose();
  expect(f.calls.some((call) => call.command.endsWith('_abort'))).toBe(false);
  await expect(f.client.status()).resolves.toMatchObject({
    state: 'active',
    profileRevision: 8,
  });
  expect(f.openedRevisions.at(-1)).toBe(8);
});

test('retains a revalidated committed Device when the next recovery peer cannot open', async () => {
  const f = fixture();
  await f.client.begin();
  await f.client.login({ username: 'zach', password: 'user-entered' });
  await f.client.finalize();
  f.failNextTransition();
  await expect(f.client.activate()).rejects.toThrow(
    'transition_ipc_unavailable',
  );
  f.failNextOpen();
  await expect(f.client.status()).rejects.toThrow('ice_unavailable');
  await f.client.dispose();
  expect(f.calls.some((call) => call.command.endsWith('_abort'))).toBe(false);
});

test('a recreated client resumes the exact host journal attempt without allocating another Device', async () => {
  const f = fixture();
  await f.client.begin();
  await f.client.login({ username: 'zach', password: 'user-entered' });
  await f.client.finalize();
  await f.client.activate();
  const restarted = f.recreatedClient();
  await expect(restarted.resume('x'.repeat(43))).rejects.toThrow(
    'native_enrollment_recovery_invalid',
  );
  await expect(restarted.resume(ENROLLMENT)).resolves.toMatchObject({
    phase: 'active',
    profileRevision: 8,
  });
  await expect(restarted.status()).resolves.toMatchObject({
    state: 'active',
    profileRevision: 8,
  });
  await restarted.dispose();
  expect(
    f.calls.filter((call) => call.command.endsWith('_begin_prepare')),
  ).toHaveLength(1);
  expect(f.calls.some((call) => call.command.endsWith('_abort'))).toBe(false);
});

test('Device Begin retains HTTP status and allowlisted host refusal from the real channel exchange', async () => {
  const failure = new Error('native_enrollment_operation_refused');
  const f = fixture({ status: 409, challengeFailure: failure });
  await expect(f.client.begin()).rejects.toBe(failure);
  expect(nativeEnrollmentFailureDiagnostic(failure)).toEqual({
    stage: 'host-accept',
    code: 'native_enrollment_operation_refused',
    httpStatus: 409,
  });
  expect(f.requests).toHaveLength(1);
  await f.client.abort();
  expect(
    f.calls.some((call) => call.command === 'station_native_enrollment_abort'),
  ).toBe(true);
});
