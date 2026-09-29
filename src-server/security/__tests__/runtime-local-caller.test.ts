// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundLocalGrantMintedOperator,
  isBoundRuntimeLocalOperator,
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../runtime-request-security.js';

const homePossession: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'local-grant-device',
  authority: 'device-credential',
  source: 'session',
  pairingSource: 'same-origin',
  locality: 'home-possession',
};

const accessRequestSameOrigin: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'access-request-device',
  authority: 'device-credential',
  source: 'session',
  pairingSource: 'same-origin',
};

const operatorPrincipal: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'operator',
  authority: 'operator-credential',
  source: 'bearer',
};

const pairingPrincipal: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'paired-phone',
  authority: 'device-credential',
  source: 'session',
  pairingSource: 'pairing-code',
};

const internalTokenPrincipal: RuntimeAuthenticatedRequestPrincipal = {
  credential: 'internal-token',
  authority: undefined,
  source: 'bearer',
  locality: 'home-possession',
};

/**
 * Every classification goes through the production seam: the auth boundary's
 * `bindRuntimeLocalOperator(request, principal)` write, then the
 * `isBoundRuntimeLocalOperator(request)` read every consumer uses.
 */
function boundLocal(
  principal: RuntimeAuthenticatedRequestPrincipal | undefined,
  init?: RequestInit,
): boolean {
  const request = new Request('http://station.test/api/diagnostics/logs', init);
  bindRuntimeLocalOperator(request, principal);
  return isBoundRuntimeLocalOperator(request);
}

describe('bound local operator — mint-time home-possession only', () => {
  it('treats a local-grant-minted credential as local', () => {
    expect(boundLocal(homePossession)).toBe(true);
  });

  it('treats the process-local internal-token principal as local', () => {
    expect(boundLocal(internalTokenPrincipal)).toBe(true);
  });

  it('a same-origin credential minted via access-request is NOT local', () => {
    expect(boundLocal(accessRequestSameOrigin)).toBe(false);
  });

  it('an operator credential is NOT local, including over loopback', () => {
    expect(boundLocal(operatorPrincipal)).toBe(false);
  });

  it('a pairing credential is NOT local', () => {
    expect(boundLocal(pairingPrincipal)).toBe(false);
  });

  it('ignores proxy and forwarding headers; only the recorded field counts', () => {
    expect(
      boundLocal(homePossession, {
        headers: { 'x-forwarded-for': '8.8.8.8', forwarded: 'for=8.8.8.8' },
      }),
    ).toBe(true);
    expect(
      boundLocal(operatorPrincipal, {
        headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' },
      }),
    ).toBe(false);
  });

  it('fails closed with no principal', () => {
    // Explicit undefined falls back to the request's own principal: none.
    expect(boundLocal(undefined)).toBe(false);
    const request = new Request('http://station.test/api/diagnostics/logs');
    expect(bindRuntimeLocalOperator(request)).toBe(false);
    expect(isBoundRuntimeLocalOperator(request)).toBe(false);
  });

  it('an unbound request is not local', () => {
    expect(
      isBoundRuntimeLocalOperator(
        new Request('http://station.test/api/diagnostics/logs'),
      ),
    ).toBe(false);
  });

  it('bindRuntimeLocalOperator is the flag diagnostics reads', () => {
    const request = new Request('http://station.test/api/diagnostics/logs');
    expect(isBoundRuntimeLocalOperator(request)).toBe(false);
    expect(bindRuntimeLocalOperator(request, homePossession)).toBe(true);
    expect(isBoundRuntimeLocalOperator(request)).toBe(true);

    const other = new Request('http://station.test/api/diagnostics/logs');
    bindRuntimeLocalOperator(other, operatorPrincipal);
    expect(isBoundRuntimeLocalOperator(other)).toBe(false);
  });

  it('the approve-capable flag requires the local-grant MINT, not just possession (station#3677 PR 3)', () => {
    const bind = (
      principal: RuntimeAuthenticatedRequestPrincipal | undefined,
    ) => {
      const request = new Request('http://station.test/api/consent/x');
      bindRuntimeLocalOperator(request, principal);
      return request;
    };

    // Unbound: refuse.
    expect(
      isBoundLocalGrantMintedOperator(
        new Request('http://station.test/api/consent/x'),
      ),
    ).toBe(false);

    // The one admitted shape.
    const desktop = bind({ ...homePossession, mintKind: 'local-grant' });
    expect(isBoundRuntimeLocalOperator(desktop)).toBe(true);
    expect(isBoundLocalGrantMintedOperator(desktop)).toBe(true);

    // Same possession, JS-resident custody: local for reads, never approve.
    const hostBrowser = bind({ ...homePossession, mintKind: 'ui-bootstrap' });
    expect(isBoundRuntimeLocalOperator(hostBrowser)).toBe(true);
    expect(isBoundLocalGrantMintedOperator(hostBrowser)).toBe(false);

    // Pre-#3677 record: locality with no recorded kind fails closed.
    expect(isBoundLocalGrantMintedOperator(bind(homePossession))).toBe(false);
    // The internal-token principal never carries a mint kind.
    expect(isBoundLocalGrantMintedOperator(bind(internalTokenPrincipal))).toBe(
      false,
    );
    // A mint kind WITHOUT possession must not admit either — the flag is a
    // conjunction, not a kind check.
    expect(
      isBoundLocalGrantMintedOperator(
        bind({ ...operatorPrincipal, mintKind: 'local-grant' }),
      ),
    ).toBe(false);
  });
});

describe('runtime authenticated request principal', () => {
  it('keeps the middleware-authenticated cookie or bearer principal on its exact request', () => {
    const request = new Request('http://station.test/api/tasks/task/room');
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'paired-device-credential',
      authority: 'device-credential',
      source: 'session',
    });
    expect(getRuntimeAuthenticatedRequestPrincipal(request)).toEqual({
      credential: 'paired-device-credential',
      authority: 'device-credential',
      source: 'session',
    });
    // Request-scoped, never ambient: another request carries no principal.
    expect(
      getRuntimeAuthenticatedRequestPrincipal(
        new Request('http://station.test/api/tasks/task/room'),
      ),
    ).toBeUndefined();
  });
});
