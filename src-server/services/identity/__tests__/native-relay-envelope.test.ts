import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from '@hpke/core';
import {
  NATIVE_RELAY_ENROLLMENT_HPKE_SUITE,
  NATIVE_RELAY_ENROLLMENT_VERSION,
  type NativeRelayEnrollmentDelivery,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { compactVerify, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import hpkeVector from '../../../../src-desktop/src/fixtures/native-enrollment-hpke-p256-base.json' with {
  type: 'json',
};
import {
  type NativeRelayDeviceBundle,
  sealNativeRelayEnrollmentDelivery,
} from '../native-relay-envelope.js';

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});
const vector = z
  .object({
    skRm: z.string(),
    pkRm: z.string(),
    enc: z.string(),
    info: z.string(),
    encryption: z.object({ ct: z.string(), pt: z.string(), aad: z.string() }),
  })
  .parse(hpkeVector);

async function fixture() {
  const station = await generateKeyPair('ES256', { extractable: true });
  const device = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(device.publicKey);
  const surface = {
    kind: 'station-native',
    appIdentifier: 'io.kontourai.station',
    channel: 'nightly',
    clientInstanceId: '55555555-5555-4555-8555-555555555555',
    keyThumbprint: 'T'.repeat(43),
  } as const;
  const stationId = '11111111-1111-4111-8111-111111111111';
  const deviceId = '33333333-3333-4333-8333-333333333333';
  const bundle: NativeRelayDeviceBundle = {
    version: NATIVE_RELAY_ENROLLMENT_VERSION,
    stationId,
    deviceId,
    deviceCredential: 'synthetic-device-fixture',
  };
  const metadata: Omit<
    NativeRelayEnrollmentDelivery,
    'enc' | 'ciphertext' | 'stationProof' | 'bundleDigest'
  > = {
    version: NATIVE_RELAY_ENROLLMENT_VERSION,
    state: 'delivered',
    responsePeerNonce: 'P'.repeat(43),
    stationSigningGeneration: 1,
    binding: {
      stationId,
      stationAudience: 'https://station.example',
      scope: {
        stationId,
        enrollmentId: '22222222-2222-4222-8222-222222222222',
        routingGeneration: 1,
      },
      surface,
      peerNonce: 'P'.repeat(43),
      enrollmentId: 'E'.repeat(43),
      reservedDeviceId: deviceId,
      recipient: {
        suite: NATIVE_RELAY_ENROLLMENT_HPKE_SUITE,
        publicKey: Buffer.from(vector.pkRm, 'hex').toString('base64url'),
      },
    },
    candidate: {
      version: 'station-native-device-binding-candidate/v1',
      stationId,
      deviceId,
      bindingId: '44444444-4444-4444-8444-444444444444',
      surface,
      deviceProofJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! },
      deviceProofKeyThumbprint: 'D'.repeat(43),
    },
    activationNonce: 'A'.repeat(43),
    expiresAt: Date.now() + 60_000,
  };
  return { station, bundle, metadata };
}

describe('native Station-authenticated HPKE delivery', () => {
  test('opens the published RFC9180 P256 vector with the fixed native suite', async () => {
    const key = await suite.kem.deserializePrivateKey(
      Buffer.from(vector.skRm, 'hex'),
    );
    const plaintext = await suite.open(
      {
        recipientKey: key,
        enc: Buffer.from(vector.enc, 'hex'),
        info: Buffer.from(vector.info, 'hex'),
      },
      Buffer.from(vector.encryption.ct, 'hex'),
      Buffer.from(vector.encryption.aad, 'hex'),
    );
    expect(Buffer.from(plaintext).toString('hex')).toBe(vector.encryption.pt);
  });

  test('delivers signed metadata and ciphertext without a renderer-visible bearer', async () => {
    const h = await fixture();
    const delivered = await sealNativeRelayEnrollmentDelivery({
      ...h,
      signingKey: h.station.privateKey,
    });
    expect(JSON.stringify(delivered)).not.toContain(h.bundle.deviceCredential);
    const verified = await compactVerify(
      delivered.stationProof,
      h.station.publicKey,
    );
    const { enc, ciphertext, stationProof: _proof, ...metadata } = delivered;
    expect(JSON.parse(Buffer.from(verified.payload).toString())).toEqual(
      metadata,
    );
    const key = await suite.kem.deserializePrivateKey(
      Buffer.from(vector.skRm, 'hex'),
    );
    const plaintext = await suite.open(
      {
        recipientKey: key,
        enc: Buffer.from(enc, 'base64url'),
        info: new TextEncoder().encode(NATIVE_RELAY_ENROLLMENT_VERSION),
      },
      Buffer.from(ciphertext, 'base64url'),
      verified.payload,
    );
    expect(JSON.parse(Buffer.from(plaintext).toString())).toEqual(h.bundle);
    await expect(
      suite.open(
        {
          recipientKey: key,
          enc: Buffer.from(enc, 'base64url'),
          info: new TextEncoder().encode(NATIVE_RELAY_ENROLLMENT_VERSION),
        },
        Buffer.from(ciphertext, 'base64url'),
        new TextEncoder().encode('other-attempt'),
      ),
    ).rejects.toThrow();
  });

  test('refuses substitution of the reserved Device and malformed recipient before encryption', async () => {
    const h = await fixture();
    await expect(
      sealNativeRelayEnrollmentDelivery({
        ...h,
        bundle: {
          ...h.bundle,
          deviceId: '99999999-9999-4999-8999-999999999999',
        },
        signingKey: h.station.privateKey,
      }),
    ).rejects.toThrow('delivery_invalid');
    await expect(
      sealNativeRelayEnrollmentDelivery({
        ...h,
        metadata: {
          ...h.metadata,
          binding: {
            ...h.metadata.binding,
            recipient: {
              suite: NATIVE_RELAY_ENROLLMENT_HPKE_SUITE,
              publicKey: 'invalid',
            },
          },
        },
        signingKey: h.station.privateKey,
      }),
    ).rejects.toThrow('recipient_invalid');
  });
});
