/**
 * #3557: the full-access refusal, composed from a real security service,
 * says when the person's Station group (not the device's grant) is what
 * stops full access, and points the operator at People instead.
 */
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  bindFullAccessRefusalIdentity,
  fullAccessRefusalBody,
} from '../../../security/full-access-refusal.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createFullAccessRefusalIdentity } from '../full-access-refusal-identity.js';

const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
const makeTempDir = trackTempDirs();

async function station() {
  const homeDir = makeTempDir('station-refusal-');
  const security = new EnvironmentSecurityService({ homeDir });
  await security.initialize();
  const pair = (scope: string, login?: string) => {
    const pairing = security.devicePairing;
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope,
    });
    const base = {
      requesterPosition: 'off-box' as const,
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Phone',
    };
    const request = login
      ? pairing.requestPairing({
          ...base,
          source: 'tailnet',
          requester: { provider: 'tailscale-serve', login },
        })
      : pairing.requestPairing(base);
    pairing.confirmRequest(
      request.requestId,
      { kind: 'presented-credential' },
      login
        ? {
            principalId: `human:tailscale-serve:${login}`,
            kind: 'verified-ingress',
          }
        : undefined,
    );
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    }).device;
  };
  const refuse = (deviceId: string) => {
    const request = new Request('http://station.test/api/orchestration', {
      method: 'POST',
    });
    setRuntimeAuthenticatedRequestPrincipal(request, {
      kind: 'credential',
      credential: 'not-used',
      authority: 'device-credential',
      deviceId,
      source: 'bearer',
    });
    bindFullAccessRefusalIdentity(
      request,
      createFullAccessRefusalIdentity(security, () => 'nightly'),
    );
    return fullAccessRefusalBody(request);
  };
  return { security, pair, refuse };
}

describe('the full-access refusal and Station groups', () => {
  test('a Member whose device already holds full access is pointed at People, with no device command', async () => {
    const { pair, refuse } = await station();
    const device = pair(`${STANDARD} approval:full-access`, 'casey');
    const body = refuse(device.id);
    expect(body.details.grant).toMatchObject({
      uiSteps: [
        'As the operator, open Settings, then Devices, then People.',
        'Find the person this device is tied to and set their group to Admin.',
      ],
    });
    expect(body.details.grant?.groupLimited).toEqual({ group: 'member' });
    expect(body.details.grant).not.toHaveProperty('cli');
    expect(body.error).toContain('in the Member group');
    expect(body.error).not.toContain('--add approval:full-access');
  });

  test('a Member whose device lacks the grant needs both steps', async () => {
    const { pair, refuse } = await station();
    const device = pair(STANDARD, 'casey');
    const body = refuse(device.id);
    const command = `npx @kontourai/station-cli@nightly environment access scope ${device.id.slice(0, 8)} --add approval:full-access`;
    // The People steps, then the command as the step AFTER them: a client
    // that predates groupLimited still reads one sequence.
    expect(body.details.grant?.uiSteps).toEqual([
      'As the operator, open Settings, then Devices, then People.',
      'Find the person this device is tied to and set their group to Admin.',
      `Then, on the Station's host, run: ${command}`,
    ]);
    expect(body.details.grant?.groupLimited).toEqual({
      group: 'member',
      cli: command,
    });
    // Never the top-level cli, which older clients offer as an alternative.
    expect(body.details.grant).not.toHaveProperty('cli');
    expect(body.error).toContain(command);
    expect(body.error).toContain('in the Member group');
  });

  test("an Admin's device, or a device tied to no one, gets the device grant path only", async () => {
    const { security, pair, refuse } = await station();
    const admin = pair(STANDARD, 'dana');
    await security.assignGroup('human:tailscale-serve:dana', 'admin');
    const own = pair(STANDARD);
    for (const device of [admin, own]) {
      const body = refuse(device.id);
      expect(body.details.grant?.uiSteps[0]).toBe(
        "Open the Station desktop app on the Station's host.",
      );
      expect(body.error).not.toContain('Member group');
      expect(body.details.grant).not.toHaveProperty('groupLimited');
      expect(body.details.grant?.cli).toContain('--add approval:full-access');
    }
  });
});
