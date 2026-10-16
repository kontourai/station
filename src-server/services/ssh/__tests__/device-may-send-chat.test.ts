/**
 * #3568: who may still send a chat message a held follow-up recorded, through
 * the real security service: a paired device or a personal access token, by
 * id, live and holding the scope the live `POST /api/orchestration/chat`
 * route requires.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { AccountDirectory } from '../../identity/account-directory.js';
import { DevicePairingService } from '../device-pairing-service.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';

const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
const makeTempDir = trackTempDirs();

async function station() {
  const homeDir = makeTempDir('station-may-send-');
  let clock = Date.UTC(2026, 9, 20);
  const security = new EnvironmentSecurityService({
    homeDir,
    now: () => clock,
  });
  await security.initialize();
  return {
    security,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/**
 * A local-account directory whose answers the test sets: `signedOutAt` is
 * the last "sign out everywhere", as Station's own accounts record it.
 */
function accounts() {
  const state = { disabled: false, signedOutAt: 0 };
  const directory: AccountDirectory = {
    issuer: 'urn:station:local-accounts:test',
    standing: (subject, since) => {
      if (subject !== 'dana') return 'unknown';
      return !state.disabled &&
        (since === undefined || since > state.signedOutAt)
        ? 'current'
        : 'disabled';
    },
    list: () => [],
  };
  return { directory, state };
}

/** A device paired to the account `dana`, the way an account approval records it. */
function pairAccountDevice(pairing: DevicePairingService, issuer: string) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope: STANDARD,
  });
  const request = pairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Dana laptop',
    requesterPosition: 'off-box',
    source: 'pairing-code',
    accountCandidate: { issuer, subject: 'dana', displayName: 'Dana' },
    accountCandidateSessionId: 'session-dana',
  });
  pairing.confirmRequest(
    request.requestId,
    { kind: 'presented-credential' },
    { principalId: 'human:local:operator', kind: 'account' },
  );
  return pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
}

function pair(pairing: DevicePairingService, login: string, scope: string) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope,
  });
  const request = pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: `${login} phone`,
    source: 'tailnet',
    requester: { provider: 'tailscale-serve', login },
  });
  pairing.confirmRequest(
    request.requestId,
    { kind: 'presented-credential' },
    {
      principalId: humanPrincipal('tailscale-serve', login, login).id,
      kind: 'verified-ingress',
    },
  );
  return pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
}

describe('deviceMaySendChat (#3568)', () => {
  test('a paired device holding the scope may; once revoked it may not', async () => {
    const { security } = await station();
    const casey = pair(security.devicePairing, 'casey', STANDARD);
    expect(security.deviceMaySendChat(casey.device.id)).toBe(true);
    security.devicePairing.revokeDevice(casey.device.id, 'operator-credential');
    expect(security.deviceMaySendChat(casey.device.id)).toBe(false);
  });

  test('a device whose grant lacks the route scope may not, including one narrowed after pairing', async () => {
    const { security } = await station();
    const reader = pair(security.devicePairing, 'robin', 'orchestration:read');
    expect(security.deviceMaySendChat(reader.device.id)).toBe(false);

    const casey = pair(security.devicePairing, 'casey', STANDARD);
    expect(security.deviceMaySendChat(casey.device.id)).toBe(true);
    security.devicePairing.setDeviceScope(
      casey.device.id,
      ['orchestration:read'],
      { kind: 'presented-credential' },
    );
    expect(security.deviceMaySendChat(casey.device.id)).toBe(false);
  });

  test('a personal access token holding the scope may, until it is revoked or expires', async () => {
    const { security, advance } = await station();
    const casey = pair(security.devicePairing, 'casey', STANDARD);
    const lasting = await security.devicePairing.mintPersonalToken({
      name: 'script',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read orchestration:operate',
      expiresAt: null,
    });
    expect(security.deviceMaySendChat(lasting.token.id)).toBe(true);
    await security.devicePairing.revokePersonalToken(lasting.token.id);
    expect(security.deviceMaySendChat(lasting.token.id)).toBe(false);

    const brief = await security.devicePairing.mintPersonalToken({
      name: 'brief',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read orchestration:operate',
      expiresAt: Date.UTC(2026, 9, 21),
    });
    expect(security.deviceMaySendChat(brief.token.id)).toBe(true);
    advance(2 * 24 * 60 * 60 * 1000);
    expect(security.deviceMaySendChat(brief.token.id)).toBe(false);
  });

  test('a read-only token may not, and an unknown id may not', async () => {
    const { security } = await station();
    const casey = pair(security.devicePairing, 'casey', STANDARD);
    const readOnly = await security.devicePairing.mintPersonalToken({
      name: 'reader',
      binding: casey.device.principalBinding!,
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read',
      expiresAt: null,
    });
    expect(security.deviceMaySendChat(readOnly.token.id)).toBe(false);
    expect(security.deviceMaySendChat('no-such-credential')).toBe(false);
  });

  test('R3-2: a token whose group cap removes the scope may not, through the token path', async () => {
    // No Station group removes `orchestration:operate` today (Member keeps
    // the standard preset), so the cap is injected here: what is tested is
    // that a token is judged by its capped scope, not its stored one.
    const homeDir = makeTempDir('station-may-send-cap-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    let capped = false;
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '11111111-1111-4111-8111-111111111111',
      capScope: (device) =>
        capped && device.principalBinding ? 'orchestration:read' : device.scope,
    });
    const token = await pairing.mintPersonalToken({
      name: 'script',
      binding: {
        provider: 'tailscale-serve',
        subject: 'casey',
        approvedAt: Date.UTC(2026, 9, 1),
        approvalId: 'approval-casey',
        approvedBy: 'human:local:operator',
      },
      ownerPrincipalId: 'human:tailscale-serve:casey',
      scope: 'orchestration:read orchestration:operate',
      expiresAt: null,
    });
    expect(
      pairing.credentialHoldsScope(token.token.id, 'orchestration:operate'),
    ).toBe(true);
    capped = true;
    expect(
      pairing.credentialHoldsScope(token.token.id, 'orchestration:operate'),
    ).toBe(false);
  });

  test('R3-2: an account-tied token may not once its account is disabled or signed out after it was made', async () => {
    const { security, now, advance } = await station();
    const { directory, state } = accounts();
    security.devicePairing.setAccountDirectory(directory);
    const mint = () =>
      security.devicePairing.mintPersonalToken({
        name: 'script',
        binding: {
          kind: 'account',
          issuer: directory.issuer,
          subject: 'dana',
          displayName: 'Dana',
          approvedAt: Date.UTC(2026, 9, 1),
          approvalId: 'approval-dana',
          approvedBy: 'human:local:operator',
        },
        ownerPrincipalId: 'human:deployment:dana',
        scope: 'orchestration:read orchestration:operate',
        expiresAt: null,
      });
    const signedOut = await mint();
    advance(1);
    const queuedAt = now();
    expect(security.deviceMaySendChat(signedOut.token.id, queuedAt)).toBe(true);
    advance(1);
    state.signedOutAt = now();
    expect(security.deviceMaySendChat(signedOut.token.id, queuedAt)).toBe(
      false,
    );

    advance(1);
    const disabled = await mint();
    expect(security.deviceMaySendChat(disabled.token.id, now())).toBe(true);
    state.disabled = true;
    expect(security.deviceMaySendChat(disabled.token.id, now())).toBe(false);
  });

  test('R3-3: an account-bound device may not once its account is disabled, or signed out since the message was queued', async () => {
    const { security, now, advance } = await station();
    const { directory, state } = accounts();
    security.devicePairing.setAccountDirectory(directory);
    const dana = pairAccountDevice(security.devicePairing, directory.issuer);
    expect(dana.device.principalBinding).toMatchObject({ kind: 'account' });
    advance(1);
    const queuedAt = now();
    expect(security.deviceMaySendChat(dana.device.id, queuedAt)).toBe(true);
    // Signed out everywhere after it queued: the session that queued it is
    // gone, so it is not sent.
    advance(1);
    state.signedOutAt = now();
    expect(security.deviceMaySendChat(dana.device.id, queuedAt)).toBe(false);
    // Queued after that sign-out (a fresh sign-in): it may.
    advance(1);
    expect(security.deviceMaySendChat(dana.device.id, now())).toBe(true);
    state.disabled = true;
    expect(security.deviceMaySendChat(dana.device.id, now())).toBe(false);
  });

  test('R3-3: an account-bound device may not when no account directory answers for its issuer', async () => {
    const { security, now } = await station();
    const { directory } = accounts();
    security.devicePairing.setAccountDirectory(directory);
    const dana = pairAccountDevice(security.devicePairing, directory.issuer);
    expect(security.deviceMaySendChat(dana.device.id, now())).toBe(true);
    security.devicePairing.setAccountDirectory(undefined);
    expect(security.deviceMaySendChat(dana.device.id, now())).toBe(false);
  });
});
