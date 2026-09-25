import { describe, expect, test } from 'vitest';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { FocusPresence } from '../../../services/presence/focus-presence.js';
import { ClientConnectionPresence } from '../../../services/ssh/client-connection-presence.js';
import { createClientStreamPresence } from '../client-stream-presence.js';

const TAB = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER_TAB = '11111111-1111-4111-8111-111111111111';

const operator: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'operator-credential-value',
  authority: 'operator-credential',
  source: 'bearer',
};
const phone: RuntimeAuthenticatedRequestPrincipal = {
  kind: 'credential',
  credential: 'phone-credential',
  authority: 'device-credential',
  deviceId: 'phone',
  source: 'session',
};

function streamRequest(
  principal: RuntimeAuthenticatedRequestPrincipal | undefined,
  clientSession: string | null = TAB,
): Request {
  const request = new Request('http://station.test/api/events', {
    headers: clientSession ? { 'X-Station-Client-Session': clientSession } : {},
  });
  if (principal) setRuntimeAuthenticatedRequestPrincipal(request, principal);
  return request;
}

function harness(local?: ClientConnectionPresence) {
  const devices = new ClientConnectionPresence();
  const focus = new FocusPresence();
  const presence = createClientStreamPresence({
    devices,
    identifyDevice: (credential) =>
      credential === 'phone-credential' ? { id: 'phone' } : null,
    focus,
    ...(local ? { local } : {}),
  });
  let seq = 0;
  /** One document of the phone reports, as the focus route records it. */
  const phoneDocument = (
    session: string,
    state: 'focused' | 'visible' | 'hidden',
  ) => {
    seq += 1;
    focus.report(
      { kind: 'device', deviceId: 'phone', principalId: 'person' },
      session.toLowerCase(),
      state,
      seq,
    );
  };
  return {
    devices,
    presence,
    phoneDocument,
    isLive: presence.inAppLiveness.isLive,
  };
}

describe('client stream presence (#2620)', () => {
  test("an operator tab's stream makes exactly that local surface live, until it closes", () => {
    const { presence, isLive } = harness();
    expect(isLive(`local:${TAB}`)).toBe(false);
    const lease = presence.connect(streamRequest(operator));
    expect(lease).toBeDefined();
    expect(isLive(`local:${TAB}`)).toBe(true);
    expect(isLive(`local:${OTHER_TAB}`)).toBe(false);
    // A local tab never makes a paired device live.
    expect(isLive('device:phone')).toBe(false);
    lease!.release();
    expect(isLive(`local:${TAB}`)).toBe(false);
  });

  test('the local surface is keyed lowercase, the way the focus route records it', () => {
    const { presence, isLive } = harness();
    presence.connect(streamRequest(operator, TAB.toUpperCase()));
    expect(isLive(`local:${TAB}`)).toBe(true);
  });

  test("a paired device's focused document with its own stream makes the device live, not a local surface", () => {
    const { presence, devices, isLive, phoneDocument } = harness();
    phoneDocument(TAB, 'focused');
    expect(isLive('device:phone')).toBe(false);
    const lease = presence.connect(streamRequest(phone));
    expect(lease).toBeDefined();
    expect(isLive('device:phone')).toBe(true);
    expect(isLive(`local:${TAB}`)).toBe(false);
    // The connected-clients view reads the same presence it always did.
    expect(devices.snapshot(['phone']).get('phone')?.sessionCount).toBe(1);
    lease!.release();
    expect(isLive('device:phone')).toBe(false);
  });

  test("a device's focused document whose stream is dead is not vouched for by another live document", () => {
    const { presence, isLive, phoneDocument } = harness();
    phoneDocument(TAB, 'focused');
    phoneDocument(OTHER_TAB, 'hidden');
    const background = presence.connect(streamRequest(phone, OTHER_TAB));
    expect(background).toBeDefined();
    expect(isLive('device:phone')).toBe(false);
    // Focus moves to the document that holds a stream: now it can toast.
    phoneDocument(TAB, 'hidden');
    phoneDocument(OTHER_TAB, 'focused');
    expect(isLive('device:phone')).toBe(true);
  });

  test('a device lease is keyed lowercase, the way the focus route records the document', () => {
    const { presence, isLive, phoneDocument } = harness();
    phoneDocument(TAB, 'focused');
    presence.connect(streamRequest(phone, TAB.toUpperCase()));
    expect(isLive('device:phone')).toBe(true);
  });

  test('a device with a live stream but no focused document is not live', () => {
    const { presence, isLive, phoneDocument } = harness();
    phoneDocument(TAB, 'visible');
    presence.connect(streamRequest(phone));
    expect(isLive('device:phone')).toBe(false);
  });

  test.each([
    ['no authenticated principal', undefined, TAB],
    [
      'an internal principal carrying the operator authority',
      { ...operator, kind: 'internal' as const },
      TAB,
    ],
    ['no client-session header', operator, null],
    ['a malformed client-session header', operator, 'not-a-uuid'],
    [
      'an unknown device credential',
      { ...phone, credential: 'revoked-credential' },
      TAB,
    ],
  ])('%s: no lease, nothing live', (_label, principal, header) => {
    const { presence, isLive } = harness();
    expect(presence.connect(streamRequest(principal, header))).toBeUndefined();
    expect(isLive(`local:${TAB}`)).toBe(false);
    expect(isLive('device:phone')).toBe(false);
  });

  test('a stream whose keepalive stops touching the lease stops being live', () => {
    let now = 0;
    const local = new ClientConnectionPresence({
      now: () => now,
      leaseMs: 90_000,
    });
    const { presence, isLive } = harness(local);
    const lease = presence.connect(streamRequest(operator))!;
    now = 60_000;
    lease.touch();
    now = 140_000;
    expect(isLive(`local:${TAB}`)).toBe(true);
    now = 150_001;
    expect(isLive(`local:${TAB}`)).toBe(false);
  });
});
