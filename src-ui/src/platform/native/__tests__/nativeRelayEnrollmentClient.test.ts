// @vitest-environment node
import {
  type ApplicationChannel,
  serveApplicationChannel,
} from '@kontourai/station-connect/application-channel';
import {
  NATIVE_RELAY_ENROLLMENT_BASE_PATH,
  NATIVE_RELAY_ENROLLMENT_VERSION,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { beforeEach, expect, test, vi } from 'vitest';
import { createNativeRelayEnrollmentClient } from '../nativeRelayEnrollmentClient';

const transport = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../nativeEnrollmentSignalingBridge', () => ({
  createNativeEnrollmentSignalingBridge: () => ({ open: transport.open }),
}));
const ORIGIN = 'https://station.example';
const ENROLLMENT = 'e'.repeat(43);
const TRANSITION = 't'.repeat(43);
const VERSION = NATIVE_RELAY_ENROLLMENT_VERSION;

beforeEach(() => vi.clearAllMocks());

function fixture() {
  const lifetime = new AbortController();
  let liveRevision = 7;
  let peerSequence = 0;
  const requests: { path: string; body: string }[] = [];
  transport.open.mockImplementation(async () => {
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
        return Response.json({
          state: path.endsWith('/login') ? 'pending' : 'response',
          path,
        });
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
        if (liveRevision !== 7) throw new Error('old_profile_revision');
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
