// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  bindRuntimeLocalOperator,
  isBoundLocalGrantMintedOperator,
  isBoundRuntimeLocalOperator,
  isLocalRuntimeCaller,
  type RuntimeAuthenticatedRequestPrincipal,
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

describe('isLocalRuntimeCaller — mint-time home-possession only', () => {
  it('treats a local-grant-minted credential as local', () => {
    expect(isLocalRuntimeCaller({ principal: homePossession })).toBe(true);
  });

  it('treats the process-local internal-token principal as local', () => {
    expect(isLocalRuntimeCaller({ principal: internalTokenPrincipal })).toBe(
      true,
    );
  });

  it('a same-origin credential minted via access-request is NOT local', () => {
    expect(isLocalRuntimeCaller({ principal: accessRequestSameOrigin })).toBe(
      false,
    );
  });

  it('an operator credential is NOT local, including over loopback', () => {
    expect(isLocalRuntimeCaller({ principal: operatorPrincipal })).toBe(false);
  });

  it('a pairing credential is NOT local', () => {
    expect(isLocalRuntimeCaller({ principal: pairingPrincipal })).toBe(false);
  });

  it('ignores socket and proxy headers; only the recorded field counts', () => {
    expect(
      isLocalRuntimeCaller({
        environment: { incoming: { socket: { remoteAddress: '8.8.8.8' } } },
        header: () => 'remote',
        principal: homePossession,
      }),
    ).toBe(true);
    expect(
      isLocalRuntimeCaller({
        environment: { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
        header: () => 'local',
        principal: operatorPrincipal,
      }),
    ).toBe(false);
  });

  it('fails closed with no principal', () => {
    expect(isLocalRuntimeCaller({})).toBe(false);
    expect(isLocalRuntimeCaller({ principal: undefined })).toBe(false);
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
