import { createHmac, randomBytes, webcrypto } from 'node:crypto';
import { buildStationProofMessage } from '@kontourai/station-contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyStationEnvironmentProof } from '../core/environmentProof';

const credential = randomBytes(32).toString('base64url');
const environmentId = 'environment-a';
const nonce = randomBytes(32).toString('base64url');

function signature(forNonce: string, key = credential) {
  return createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(buildStationProofMessage(environmentId, forNonce))
    .digest('base64url');
}

describe('environment proof verification', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: webcrypto,
    });
  });

  it('accepts only a valid nonce-bound signature', async () => {
    await expect(
      verifyStationEnvironmentProof({
        credential,
        environmentId,
        nonce,
        response: {
          protocolVersion: 1,
          environmentId,
          nonce,
          signature: signature(nonce),
        },
      }),
    ).resolves.toBe(true);
  });

  it('rejects wrong signatures, credentials, environments, and replayed nonces', async () => {
    const response = {
      protocolVersion: 1,
      environmentId,
      nonce,
      signature: signature(nonce),
    };
    await expect(
      verifyStationEnvironmentProof({
        credential: randomBytes(32).toString('base64url'),
        environmentId,
        nonce,
        response,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyStationEnvironmentProof({
        credential,
        environmentId: 'environment-b',
        nonce,
        response,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyStationEnvironmentProof({
        credential,
        environmentId,
        nonce: randomBytes(32).toString('base64url'),
        response,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyStationEnvironmentProof({
        credential,
        environmentId,
        nonce,
        response: { ...response, signature: 'x'.repeat(43) },
      }),
    ).resolves.toBe(false);
  });
});
