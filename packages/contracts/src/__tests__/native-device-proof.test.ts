import { describe, expect, test } from 'vitest';
import { APPLICATION_SESSION_PROOF_TYPE } from '../application-session.js';
import { STATION_CONNECTION_PROOF_TYPE } from '../connection-proof.js';
import {
  NATIVE_DEVICE_PROOF_HEADER,
  NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  NATIVE_DEVICE_PROOF_REQUEST_PURPOSE,
  NATIVE_DEVICE_PROOF_TYPE,
  NATIVE_DEVICE_PROOF_VERSION,
} from '../native-device-proof.js';
import { SELF_HOSTED_BROKER_NATIVE_REQUEST_PROOF_TYPE } from '../self-hosted-broker.js';

describe('native device proof identities', () => {
  test('the proof type is distinct from account continuation, Station and broker proofs', () => {
    expect(NATIVE_DEVICE_PROOF_TYPE).not.toBe(APPLICATION_SESSION_PROOF_TYPE);
    expect(NATIVE_DEVICE_PROOF_TYPE).not.toBe(
      SELF_HOSTED_BROKER_NATIVE_REQUEST_PROOF_TYPE,
    );
    expect(NATIVE_DEVICE_PROOF_TYPE).not.toBe(STATION_CONNECTION_PROOF_TYPE);
    expect(NATIVE_DEVICE_PROOF_HEADER).toBe('X-Station-Native-Device-Proof');
  });

  test('request purpose is request-only and the lifetime is bounded to 30 seconds', () => {
    expect(NATIVE_DEVICE_PROOF_REQUEST_PURPOSE).toBe('request');
    expect(NATIVE_DEVICE_PROOF_LIFETIME_SECONDS).toBe(30);
    expect(NATIVE_DEVICE_PROOF_VERSION).toBe('station-native-device-proof/v1');
  });
});
