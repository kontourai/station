/**
 * #3586 security review: the terminal and voice WebSocket listeners both
 * authenticate through `credentialAuthorizedForScope` (runtime-initialize.ts
 * for voice, runtime-service-bootstrap.ts for terminal). A WebSocket session
 * runs outside the HTTP gates, so an account-bound device, an account-tied
 * token and any personal access token must be refused there whatever their
 * scope. Driven with the real EnvironmentSecurityService and real pairing.
 */
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { AccountDirectory } from '../../services/identity/account-directory.js';
import { deploymentAccountPrincipal } from '../../services/identity/deployment-authentication-service.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import {
  credentialAuthorizedForScope,
  PAIRING_WS_SCOPES,
} from '../pairing-route-scopes.js';

const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
const ISSUER = 'urn:station:local-accounts:ws-test';
const makeTempDir = trackTempDirs();

async function station() {
  const security = new EnvironmentSecurityService({
    homeDir: makeTempDir('station-ws-refusal-'),
  });
  const { credential: operator } = await security.initialize();
  const pairing = security.devicePairing;
  const directory: AccountDirectory = {
    issuer: ISSUER,
    standing: () => 'current',
    list: () => [],
  };
  pairing.setAccountDirectory(directory);
  const pair = (
    name: string,
    bind?: 'tailnet' | 'account',
  ): ReturnType<typeof pairing.exchange> => {
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: STANDARD,
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
      ...(bind === 'tailnet'
        ? {
            source: 'tailnet' as const,
            requester: { provider: 'tailscale-serve', login: 'casey' },
          }
        : { source: 'same-origin' as const }),
      ...(bind === 'account'
        ? {
            requireAccountBinding: true,
            accountCandidate: {
              issuer: ISSUER,
              subject: 'dana',
              displayName: 'Dana',
            },
            accountCandidateSessionId: 'candidate-proof',
          }
        : {}),
    });
    pairing.confirmRequest(
      request.requestId,
      { kind: 'presented-credential' },
      bind === 'tailnet'
        ? {
            principalId: humanPrincipal('tailscale-serve', 'casey', 'casey').id,
            kind: 'verified-ingress',
          }
        : bind === 'account'
          ? {
              principalId: deploymentAccountPrincipal(ISSUER, 'dana', 'Dana')
                .id,
              kind: 'account',
            }
          : undefined,
    );
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  };
  const mintFor = async (device: ReturnType<typeof pair>) =>
    (
      await pairing.mintPersonalToken({
        name: 'script',
        binding: device.device.principalBinding!,
        ownerPrincipalId: 'owner',
        scope: 'orchestration:read orchestration:operate',
        expiresAt: null,
      })
    ).secret;
  return { security, operator, pair, mintFor };
}

describe.each([
  ['voice', PAIRING_WS_SCOPES.voice],
  ['terminal', PAIRING_WS_SCOPES.terminal],
] as const)('%s WebSocket credential check', (_name, scope) => {
  test('an ordinary device, a Tailscale-tied device and the operator are admitted', async () => {
    const h = await station();
    for (const credential of [
      h.pair('laptop').credential,
      h.pair('casey phone', 'tailnet').credential,
      h.operator,
    ])
      await expect(
        credentialAuthorizedForScope(h.security, scope, credential),
      ).resolves.toBe(true);
  });

  test('an account-bound device, an account token and a Tailscale token are refused', async () => {
    const h = await station();
    const account = h.pair('dana laptop', 'account');
    const tailnet = h.pair('casey phone', 'tailnet');
    const cases = {
      'account-bound device': account.credential,
      'account token': await h.mintFor(account),
      'tailnet token': await h.mintFor(tailnet),
    };
    for (const [label, credential] of Object.entries(cases)) {
      // Each credential is valid on its own: only the WebSocket refuses it.
      expect(h.security.verifyCredential(credential), label).toBe(true);
      await expect(
        credentialAuthorizedForScope(h.security, scope, credential),
        label,
      ).resolves.toBe(false);
    }
  });
});
