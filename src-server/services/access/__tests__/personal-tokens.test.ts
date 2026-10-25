/**
 * #3557: personal access tokens through the real security service: a token
 * authenticates as a headless device of its person, is stored only as a
 * hash, expires, revokes, and never touches the paired-device registry.
 */
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { matchPairingScopeRule } from '../../../security/pairing-route-scopes.js';
import type { AccountDirectory } from '../../identity/account-directory.js';
import type { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import {
  PERSONAL_TOKENS_FILE,
  PersonalTokenUnavailableError,
} from '../personal-token-store.js';

const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
const makeTempDir = trackTempDirs();

async function station() {
  const homeDir = makeTempDir('station-tokens-');
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
    const minted = await security.devicePairing.mintPersonalToken({
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
    const expiring = await mint(now() + 60_000);
    const revoking = await mint(null);
    expect(security.verifyCredential(expiring.secret)).toBe(true);
    advance(60_000);
    expect(security.verifyCredential(expiring.secret)).toBe(false);

    // Someone else cannot revoke it by guessing the id.
    expect(
      await security.devicePairing.revokePersonalToken(
        revoking.token.id,
        'human:tailscale-serve:dana',
      ),
    ).toBe(false);
    expect(security.verifyCredential(revoking.secret)).toBe(true);
    expect(
      await security.devicePairing.revokePersonalToken(
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
      await expect(mint(scope)(), scope).rejects.toThrow();
    await expect(mint('orchestration:read', now() - 1)()).rejects.toThrow();
    await expect(
      mint('orchestration:read', now() + 400 * 24 * 60 * 60 * 1000)(),
    ).rejects.toThrow();
  });

  test.skipIf(process.platform === 'win32')(
    'a token file that is not owner-only authenticates no one after a restart',
    async () => {
      const { homeDir, security } = await station();
      const casey = pairCasey(security.devicePairing);
      const minted = await security.devicePairing.mintPersonalToken({
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
    const minted = await security.devicePairing.mintPersonalToken({
      name: 'script',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read',
      expiresAt: null,
    });
    await security.resetEnvironment();
    expect(security.verifyCredential(minted.secret)).toBe(false);
  });

  test('a token minted while a reset runs does not survive it', async () => {
    const { security } = await station();
    const casey = pairCasey(security.devicePairing);
    const pairing = security.devicePairing;
    const clear = pairing.clearPersonalTokens.bind(pairing);
    let minted: { secret: string } | undefined;
    // A mint lands right after the reset's first revocation pass.
    vi.spyOn(pairing, 'clearPersonalTokens').mockImplementationOnce(
      async () => {
        await clear();
        minted = await pairing.mintPersonalToken({
          name: 'racer',
          binding: casey.device.principalBinding!,
          ownerPrincipalId: 'human:tailscale-serve:casey',
          scope: 'orchestration:read',
          expiresAt: null,
        });
      },
    );
    await security.resetEnvironment();
    expect(minted).toBeDefined();
    expect(security.verifyCredential(minted!.secret)).toBe(false);
  });

  test('a reset that cannot revoke tokens changes nothing', async () => {
    const { homeDir, security } = await station();
    const casey = pairCasey(security.devicePairing);
    const environmentId = async () =>
      (await new EnvironmentSecurityService({ homeDir }).initialize())
        .environmentId;
    const before = await environmentId();
    // The token record's path is unusable: a directory sits there.
    mkdirSync(join(homeDir, 'security', PERSONAL_TOKENS_FILE));
    await expect(security.resetEnvironment()).rejects.toThrow();
    expect(await environmentId()).toBe(before);
    expect(security.verifyCredential(casey.credential)).toBe(true);
  });

  test('a revocation holds for another Station process on the home, which never writes it back', async () => {
    const { homeDir, security, advance, now } = await station();
    const casey = pairCasey(security.devicePairing);
    const minted = await security.devicePairing.mintPersonalToken({
      name: 'script',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read',
      expiresAt: null,
    });
    const other = new EnvironmentSecurityService({ homeDir, now });
    await other.initialize();
    // Twice: the first records a last use; the second is a plain lookup.
    expect(other.verifyCredential(minted.secret)).toBe(true);
    expect(other.verifyCredential(minted.secret)).toBe(true);

    expect(
      await security.devicePairing.revokePersonalToken(
        minted.token.id,
        'human:tailscale-serve:casey',
      ),
    ).toBe(true);
    expect(other.verifyCredential(minted.secret)).toBe(false);
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
      await security.devicePairing.revokePersonalToken(
        (await mint(null)).token.id,
      );
    await mint(now() + 1_000);
    advance(2_000);
    const kept = await mint(null);
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
      const first = await mint();
      const path = join(homeDir, 'security', PERSONAL_TOKENS_FILE);
      chmodSync(path, 0o644);
      expect(security.verifyCredential(first.secret)).toBe(false);
      await expect(mint()).rejects.toThrow(PersonalTokenUnavailableError);
      await expect(
        security.devicePairing.revokePersonalToken(first.token.id),
      ).rejects.toThrow(PersonalTokenUnavailableError);
      expect(readFileSync(path, 'utf8')).toContain(first.token.id);
    },
  );

  test('a person holds at most 20 active tokens, and only a Tailscale-tied person holds any', async () => {
    const { security } = await station();
    const casey = pairCasey(security.devicePairing);
    const mint = () =>
      security.devicePairing.mintPersonalToken({
        name: 'script',
        binding: casey.device.principalBinding!,
        ownerPrincipalId: 'human:tailscale-serve:casey',
        scope: 'orchestration:read',
        expiresAt: null,
      });
    for (let count = 0; count < 20; count += 1) await mint();
    await expect(mint()).rejects.toMatchObject({
      code: 'identity_credential_quota_reached',
    });
    await expect(
      security.devicePairing.mintPersonalToken({
        name: 'script',
        binding: { kind: 'account', issuer: 'urn:x', subject: 'dana' },
        ownerPrincipalId: 'account:urn:x:dana',
        scope: 'orchestration:read',
        expiresAt: null,
      } as never),
    ).rejects.toMatchObject({ code: 'account_bound_person' });
  });

  test('#3586: an account-tied token is made and accepted only while its issuer directory says the account is current', async () => {
    const { security, advance, now } = await station();
    const pairing = security.devicePairing;
    const standing = new Map<string, 'current' | 'disabled'>([
      ['dana', 'current'],
    ]);
    let revokedAt = 0;
    const directory: AccountDirectory = {
      issuer: 'urn:station:local-accounts:test',
      standing: (subject, since) => {
        const state = standing.get(subject);
        if (!state) return 'unknown';
        return state === 'current' && (since === undefined || since > revokedAt)
          ? 'current'
          : 'disabled';
      },
      list: () => [],
    };
    // The shape an approved account pairing records.
    const accountBinding = (issuer: string, subject: string) =>
      ({
        kind: 'account',
        issuer,
        subject,
        displayName: subject,
        approvedAt: Date.UTC(2026, 9, 1),
        approvalId: `approval-${subject}`,
        approvedBy: 'human:local:operator',
      }) as const;
    const mint = (issuer: string, subject: string) =>
      pairing.mintPersonalToken({
        name: 'script',
        binding: accountBinding(issuer, subject),
        ownerPrincipalId: `human:deployment:${subject}`,
        scope: 'orchestration:read',
        expiresAt: null,
      });
    const dana = accountBinding(directory.issuer, 'dana');
    expect(pairing.canHoldPersonalToken(dana)).toBe(false);
    await expect(mint(directory.issuer, 'dana')).rejects.toMatchObject({
      code: 'account_bound_person',
    });

    pairing.setAccountDirectory(directory);
    expect(pairing.canHoldPersonalToken(dana)).toBe(true);
    expect(
      pairing.canHoldPersonalToken({ ...dana, issuer: 'urn:elsewhere' }),
    ).toBe(false);
    for (const [issuer, subject] of [
      ['urn:elsewhere', 'dana'],
      [directory.issuer, 'nobody'],
    ])
      await expect(mint(issuer, subject)).rejects.toMatchObject({
        code: 'account_bound_person',
      });
    const { secret } = await mint(directory.issuer, 'dana');
    expect(pairing.identifyDevice(secret)?.principalBinding).toEqual(dana);

    // Signed out everywhere after the token was made: no longer current.
    advance(1);
    revokedAt = now();
    expect(pairing.identifyDevice(secret)).toBeNull();
    expect(pairing.verifyCredential(secret)).toBe(false);
    // And one made after that is current again.
    advance(1);
    const later = await mint(directory.issuer, 'dana');
    expect(pairing.verifyCredential(later.secret)).toBe(true);
    standing.set('dana', 'disabled');
    expect(pairing.verifyCredential(later.secret)).toBe(false);
    await expect(mint(directory.issuer, 'dana')).rejects.toMatchObject({
      code: 'account_bound_person',
    });
  });
});

test('outside management refuses a personal token at the scope layer even if it holds access:manage', async () => {
  const { security } = await station();
  const casey = pairCasey(security.devicePairing);
  const minted = await security.devicePairing.mintPersonalToken({
    name: 'script',
    binding: casey.device.principalBinding!,
    ownerPrincipalId: 'human:tailscale-serve:casey',
    scope: 'orchestration:read',
    expiresAt: null,
  });
  expect(security.verifyCredential(minted.secret)).toBe(true);
  // Model a future broader token issuance policy; this independent refusal must still hold.
  const identity = security.identifyDevice(minted.secret)!;
  const identify = vi
    .spyOn(security, 'identifyDevice')
    .mockReturnValue({ ...identity, scope: 'access:manage' });
  const scope = vi
    .spyOn(security, 'resolveGrantedScope')
    .mockReturnValue('access:manage');
  try {
    for (const [method, path] of [
      ['GET', '/api/outside-agent/clients'],
      ['GET', '/api/outside-agent/redirect-origins'],
      ['GET', '/api/outside-agent/cors-origins'],
      ...['review', 'confirm', 'deny', 'register'].map((leaf) => [
        'POST',
        `/api/outside-agent/host/${leaf}`,
      ]),
      ['POST', '/api/outside-agent/grants/grant/change'],
      ['POST', '/api/outside-agent/grants/grant/revoke'],
      ['POST', '/api/outside-agent/redirect-origins/change'],
      ['POST', '/api/outside-agent/cors-origins/change'],
    ]) {
      expect(matchPairingScopeRule(method!, path!)?.scope).toBe(
        'access:manage',
      );
      expect(security.resolveGrantedScope(minted.secret)).toBe('access:manage');
      expect(
        security.authorizeCredential(minted.secret, {
          method: method!,
          path: path!,
        }),
        path,
      ).toBe(false);
    }
    // Positive control: the same valid token passes an ordinary read's credential gate.
    expect(
      security.authorizeCredential(minted.secret, {
        method: 'GET',
        path: '/api/projects',
      }),
    ).toBe(true);
  } finally {
    identify.mockRestore();
    scope.mockRestore();
  }
});
