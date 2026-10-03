import { createHash } from 'node:crypto';
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
import { CompactSign } from 'jose';

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});
const encoder = new TextEncoder();
const MAX_BUNDLE_BYTES = 16 * 1024;
const NATIVE_ENROLLMENT_DELIVERY_PROOF_TYPE =
  'station-native-relay-enrollment-delivery+jws';

/** Private server plaintext. The renderer-facing delivery contract contains only ciphertext. */
export interface NativeRelayDeviceBundle {
  readonly version: typeof NATIVE_RELAY_ENROLLMENT_VERSION;
  readonly stationId: string;
  readonly deviceId: string;
  readonly deviceCredential: string;
}

/**
 * Fresh single-shot HPKE context. The signed plaintext digest is essential:
 * anybody knows the recipient public key and can encrypt replacement bytes,
 * but cannot replace the independently Station-signed bundle digest.
 */
export async function sealNativeRelayEnrollmentDelivery(input: {
  readonly metadata: Omit<
    NativeRelayEnrollmentDelivery,
    'enc' | 'ciphertext' | 'stationProof' | 'bundleDigest'
  >;
  readonly bundle: NativeRelayDeviceBundle;
  readonly signingKey: Parameters<CompactSign['sign']>[0];
}): Promise<NativeRelayEnrollmentDelivery> {
  const { metadata, bundle } = input;
  const recipient = metadata.binding.recipient;
  if (
    recipient.suite.kem !== NATIVE_RELAY_ENROLLMENT_HPKE_SUITE.kem ||
    recipient.suite.kdf !== NATIVE_RELAY_ENROLLMENT_HPKE_SUITE.kdf ||
    recipient.suite.aead !== NATIVE_RELAY_ENROLLMENT_HPKE_SUITE.aead ||
    bundle.version !== NATIVE_RELAY_ENROLLMENT_VERSION ||
    bundle.stationId !== metadata.binding.stationId ||
    bundle.deviceId !== metadata.binding.reservedDeviceId ||
    metadata.candidate.deviceId !== bundle.deviceId ||
    metadata.candidate.stationId !== bundle.stationId ||
    !bundle.deviceCredential ||
    bundle.deviceCredential.length > 8192
  )
    throw new Error('native_enrollment_delivery_invalid');
  const recipientBytes = Buffer.from(recipient.publicKey, 'base64url');
  if (
    recipientBytes.length !== 65 ||
    recipientBytes[0] !== 4 ||
    recipientBytes.toString('base64url') !== recipient.publicKey
  )
    throw new Error('native_enrollment_recipient_invalid');
  const plaintext = Buffer.from(JSON.stringify(bundle));
  if (plaintext.length > MAX_BUNDLE_BYTES)
    throw new Error('native_enrollment_delivery_invalid');
  try {
    const signed = {
      ...metadata,
      bundleDigest: createHash('sha256').update(plaintext).digest('base64url'),
    };
    const aad = encoder.encode(JSON.stringify(signed));
    const stationProof = await new CompactSign(aad)
      .setProtectedHeader({
        alg: 'ES256',
        typ: NATIVE_ENROLLMENT_DELIVERY_PROOF_TYPE,
      })
      .sign(input.signingKey);
    const publicKey = await suite.kem.deserializePublicKey(recipientBytes);
    const sealed = await suite.seal(
      {
        recipientPublicKey: publicKey,
        info: encoder.encode(NATIVE_RELAY_ENROLLMENT_VERSION),
      },
      plaintext,
      aad,
    );
    return {
      ...signed,
      enc: Buffer.from(sealed.enc).toString('base64url'),
      ciphertext: Buffer.from(sealed.ct).toString('base64url'),
      stationProof,
    };
  } finally {
    plaintext.fill(0);
  }
}
