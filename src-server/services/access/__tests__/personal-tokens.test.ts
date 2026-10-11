/**
 * #3557: personal access tokens through the real security service: a token
 * authenticates as a headless device of its person, is stored only as a
 * hash, expires, revokes, and never touches the paired-device registry.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test } from 'vitest';
import type { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import {
  PERSONAL_TOKENS_FILE,
  PersonalTokenUnavailableError,
} from '../personal-token-store.js';

const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

async function station() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-tokens-'));
  homes.push(homeDir);
  let clock = Date.UTC(2026, 9, 20);
  const security = new EnvironmentSecurityService({
    homeDir,
    now: () => clock,
  });
  await security.initialize();
  return {
    homeDir,
    security,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

function pairCasey(pairing: DevicePairingService) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope: STANDARD,
  });
  const request = pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Casey phone',
    source: 'tailnet',
    requester: { provider: 'tailscale-serve', login: 'casey' },
  });
  pairing.confirmRequest(
    request.requestId,
    { kind: 'presented-credential' },
    {
      principalId: humanPrincipal('tailscale-serve', 'casey', 'casey').id,
      kind: 'verified-ingress',
    },
  );
  return pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
}

describe('personal access tokens', () => {
  test('a token authenticates as its person, with only its own scope, stored only as a hash', async () => {
    const { homeDir, security } = await station();
    const casey = pairCasey(security.devicePairing);
    const minted = security.devicePairing.mintPersonalToken({
      name: 'CI script',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read',
      expiresAt: null,
    });
    expect(minted.secret).toMatch(/^stp_/);
    expect(security.verifyCredential(minted.secret)).toBe(true);
    expect(security.resolveGrantedScope(minted.secret)).toBe(
      'orchestration:read',
    );
    const device = security.identifyDevice(minted.secret);
    expect(device).toMatchObject({
      credentialKind: 'personal-token',
      principalBinding: casey.device.principalBinding,
    });
    // Never a pairing decision, never device management.
    expect(security.credentialMayDecidePairingRequests(minted.secret)).toBe(
      false,
    );
    expect(
      security.authorizeCredential(minted.secret, {
        method: 'GET',
        path: '/api/pairing/devices',
      }),
    ).toBe(false);

    const onDisk = readFileSync(
      join(homeDir, 'security', PERSONAL_TOKENS_FILE),
      'utf8',
    );
    expect(onDisk).not.toContain(minted.secret);
    // The device registry is untouched: an older Station still reads it.
    expect(
      readFileSync(join(homeDir, 'security', 'paired-devices.json'), 'utf8'),
    ).not.toContain(minted.token.id);
  });

  test('an expired or revoked token authenticates no one', async () => {
    const { security, advance, now } = await station();
    const casey = pairCasey(security.devicePairing);
    const mint = (expiresAt: number | null) =>
      security.devicePairing.mintPersonalToken({
        name: 'script',
        binding: casey.device.principalBinding!,
        ownerPrincipalId: 'human:tailscale-serve:casey',
        scope: 'orchestration:read orchestration:operate',
        expiresAt,
      });
    const expiring = mint(now() + 60_000);
    const revoking = mint(null);
    expect(security.verifyCredential(expiring.secret)).toBe(true);
    advance(60_000);
    expect(security.verifyCredential(expiring.secret)).toBe(false);

    // Someone else cannot revoke it by guessing the id.
    expect(
      security.devicePairing.revokePersonalToken(
        revoking.token.id,
        'human:tailscale-serve:dana',
      ),
    ).toBe(false);
    expect(security.verifyCredential(revoking.secret)).toBe(true);
    expect(
      security.devicePairing.revokePersonalToken(
        revoking.token.id,
        'human:tailscale-serve:casey',
      ),
    ).toBe(true);
    expect(security.verifyCredential(revoking.secret)).toBe(false);
    expect(
      security.devicePairing.listPersonalTokens('human:tailscale-serve:casey'),
    ).toEqual([]);
  });

  test('a token carries only Read, optionally Operate; anything else, or a bad expiry, is refused', async () => {
    const { security, now } = await station();
    const casey = pairCasey(security.devicePairing);
    const mint =
      (scope: string, expiresAt: number | null = null) =>
      () =>
        security.devicePairing.mintPersonalToken({
          name: 'script',
          binding: casey.device.principalBinding!,
          ownerPrincipalId: 'human:tailscale-serve:casey',
          scope,
          expiresAt,
        });
    for (const scope of [
      'orchestration:operate',
      'orchestration:read terminal:operate',
      'orchestration:read coding:exec',
      'orchestration:read access:manage',
    ])
      expect(mint(scope), scope).toThrow();
    expect(mint('orchestration:read', now() - 1)).toThrow();
    expect(
      mint('orchestration:read', now() + 400 * 24 * 60 * 60 * 1000),
    ).toThrow();
  });

  test.skipIf(process.platform === 'win32')(
    'a token file that is not owner-only authenticates no one after a restart',
    async () => {
      const { homeDir, security } = await station();
      const casey = pairCasey(security.devicePairing);
      const minted = security.devicePairing.mintPersonalToken({
        name: 'script',
        binding: casey.device.principalBinding!,
        ownerPrincipalId: 'human:tailscale-serve:casey',
        scope: 'orchestration:read',
        expiresAt: null,
      });
      const restart = async () => {
        const next = new EnvironmentSecurityService({ homeDir });
        await next.initialize();
        return next;
      };
      expect((await restart()).verifyCredential(minted.secret)).toBe(true);
      chmodSync(join(homeDir, 'security', PERSONAL_TOKENS_FILE), 0o644);
      expect((await restart()).verifyCredential(minted.secret)).toBe(false);
    },
  );

  test('an environment reset revokes every token', async () => {
    const { security } = await station();
    const casey = pairCasey(security.devicePairing);
    const minted = security.devicePairing.mintPersonalToken({
      name: 'script',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read',
      expiresAt: null,
    });
    await security.resetEnvironment();
    expect(security.verifyCredential(minted.secret)).toBe(false);
  });

  test('a revocation holds for another Station process on the home, which never writes it back', async () => {
    const { homeDir, security, advance, now } = await station();
    const casey = pairCasey(security.devicePairing);
    const minted = security.devicePairing.mintPersonalToken({
      name: 'script',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read',
      expiresAt: null,
    });
    const other = new EnvironmentSecurityService({ homeDir, now });
    await other.initialize();
    expect(other.verifyCredential(minted.secret)).toBe(true);

    expect(
      security.devicePairing.revokePersonalToken(
        minted.token.id,
        'human:tailscale-serve:casey',
      ),
    ).toBe(true);
    // Long enough that a lookup would record a last use.
    advance(48 * 60 * 60 * 1000);
    expect(other.verifyCredential(minted.secret)).toBe(false);
    const fresh = new EnvironmentSecurityService({ homeDir, now });
    await fresh.initialize();
    expect(fresh.verifyCredential(minted.secret)).toBe(false);
  });

  test('revoked and expired tokens leave no record behind', async () => {
    const { homeDir, security, advance, now } = await station();
    const casey = pairCasey(security.devicePairing);
    const mint = (expiresAt: number | null) =>
      security.devicePairing.mintPersonalToken({
        name: 'script',
        binding: casey.device.principalBinding!,
        ownerPrincipalId: 'human:tailscale-serve:casey',
        scope: 'orchestration:read',
        expiresAt,
      });
    for (let cycle = 0; cycle < 30; cycle += 1)
      security.devicePairing.revokePersonalToken(mint(null).token.id);
    mint(now() + 1_000);
    advance(2_000);
    const kept = mint(null);
    const onDisk = JSON.parse(
      readFileSync(join(homeDir, 'security', PERSONAL_TOKENS_FILE), 'utf8'),
    ) as { tokens: { id: string }[] };
    expect(onDisk.tokens.map((token) => token.id)).toEqual([kept.token.id]);
  });

  test.skipIf(process.platform === 'win32')(
    'a token file Station cannot trust is never written over',
    async () => {
      const { homeDir, security } = await station();
      const casey = pairCasey(security.devicePairing);
      const mint = () =>
        security.devicePairing.mintPersonalToken({
          name: 'script',
          binding: casey.device.principalBinding!,
          ownerPrincipalId: 'human:tailscale-serve:casey',
          scope: 'orchestration:read',
          expiresAt: null,
        });
      const first = mint();
      const path = join(homeDir, 'security', PERSONAL_TOKENS_FILE);
      chmodSync(path, 0o644);
      expect(security.verifyCredential(first.secret)).toBe(false);
      expect(mint).toThrow(PersonalTokenUnavailableError);
      expect(readFileSync(path, 'utf8')).toContain(first.token.id);
    },
  );
});
