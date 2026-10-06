/**
 * kontourai/station#1418, #1419 review, MEDIUM: `pagehide` used to send a
 * raw `keepalive` fetch for every connection, which can only ever carry a
 * same-origin browser cookie — never a native shell's Rust-owned bearer, nor
 * a browser-relay/broker connection's own exchange. This covers the
 * extracted predicate and the tiny always-loaded signal seam that carries
 * its live value to the (lazily loaded) coordinator.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  isPluginCommandEffectCookieAuthEligible,
  notifyPluginCommandEffectCookieAuthEligibility,
  registerPluginCommandEffectCookieAuthHandler,
} from '../plugin-command-effect-switch-signal';

describe('isPluginCommandEffectCookieAuthEligible', () => {
  test('eligible only for a same-origin browser device-session with no broker route', () => {
    expect(
      isPluginCommandEffectCookieAuthEligible({
        isTauri: false,
        credentialState: 'device-session',
        hasBrokerRoute: false,
      }),
    ).toBe(true);
  });

  test('never eligible inside a native shell, whatever the credential state', () => {
    expect(
      isPluginCommandEffectCookieAuthEligible({
        isTauri: true,
        credentialState: 'device-session',
        hasBrokerRoute: false,
      }),
    ).toBe(false);
  });

  test('never eligible for a browser-relay/broker connection: it authenticates through its own exchange, not an ambient cookie for apiBase', () => {
    expect(
      isPluginCommandEffectCookieAuthEligible({
        isTauri: false,
        credentialState: 'device-session',
        hasBrokerRoute: true,
      }),
    ).toBe(false);
  });

  test.each(['not-required', 'required', 'saved', null, undefined] as const)(
    'never eligible for a non-device-session credential state (%s) — that is a bearer, not an ambient cookie',
    (credentialState) => {
      expect(
        isPluginCommandEffectCookieAuthEligible({
          isTauri: false,
          credentialState,
          hasBrokerRoute: false,
        }),
      ).toBe(false);
    },
  );
});

describe('plugin-command-effect cookie-auth signal seam', () => {
  beforeEach(() => {
    // Reset the module's latched state so tests do not observe each other's
    // last-notified value.
    notifyPluginCommandEffectCookieAuthEligibility(false);
  });

  test('delivers the CURRENT latched value immediately on registration, in case the notify already ran before the coordinator ever loaded', () => {
    notifyPluginCommandEffectCookieAuthEligibility(true);
    const handler = vi.fn();
    registerPluginCommandEffectCookieAuthHandler(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(true);
  });

  test('a later notify reaches the already-registered handler', () => {
    const handler = vi.fn();
    registerPluginCommandEffectCookieAuthHandler(handler);
    handler.mockClear();
    notifyPluginCommandEffectCookieAuthEligibility(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(true);
    notifyPluginCommandEffectCookieAuthEligibility(false);
    expect(handler).toHaveBeenLastCalledWith(false);
  });
});
