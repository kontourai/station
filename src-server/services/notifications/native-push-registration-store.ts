/**
 * Native push registrations, in a sidecar beside the paired-device registry:
 * `security/native-push-registrations.json` (0600), keyed by device id.
 *
 * A sidecar and not a field on the device record because the device registry
 * is read with a strict key check: an older Station that finds an unknown
 * field there refuses the whole registry and every paired device with it.
 * An older Station simply never opens this file.
 *
 * The owner is `DevicePairingService`, which drops a device's entry wherever
 * it revokes or removes the device, and only lists entries whose device is
 * still active — so a failed drop can never resurrect a revoked device's
 * pushes.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  NATIVE_PUSH_ANDROID_PACKAGES,
  type NativePushRegistrationRequest,
} from '@kontourai/station-contracts/native-push';
import {
  readPrivateJsonFile,
  writePrivateJsonFileSync,
} from './private-json-file.js';

const FILE_NAME = 'native-push-registrations.json';
const LABEL = 'Native push registrations';
const MAX_FILE_BYTES = 512 * 1024;
const RANDOM_ID_BYTES = 16;
const PAYLOAD_KEY_BYTES = 32;
const REGISTRATION_KEYS =
  'packageName,payloadKey,platform,registrationId,stationKey,token,updatedAt';
const REGISTRATION_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
/** 32 bytes, base64url without padding. */
const PAYLOAD_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface NativePushRegistration extends NativePushRegistrationRequest {
  /** 128 random bits, base64url; kept across token rotation. */
  registrationId: string;
  /** AES-256 key the card is sealed with; kept across token rotation. */
  payloadKey: string;
  /** The push key thumbprint the phone was told to pin. */
  stationKey: string;
  updatedAt: number;
}

/** The registration store is present but unreadable; nothing is guessed. */
export class NativePushRegistrationStoreError extends Error {
  constructor() {
    super(`${LABEL} are unreadable or unsafe`);
  }
}

/**
 * The request half, shared by the route and the persisted-record check so the
 * two cannot disagree about what a registrable token is.
 */
export function isValidNativePushRequest(
  value: unknown,
): value is NativePushRegistrationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === 'string' &&
    record.token.length >= 20 &&
    record.token.length <= 4096 &&
    !/\s/.test(record.token) &&
    typeof record.packageName === 'string' &&
    (NATIVE_PUSH_ANDROID_PACKAGES as readonly string[]).includes(
      record.packageName,
    ) &&
    record.platform === 'android'
  );
}

function isValidRegistration(value: unknown): value is NativePushRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === REGISTRATION_KEYS &&
    isValidNativePushRequest(record) &&
    typeof record.registrationId === 'string' &&
    REGISTRATION_ID_PATTERN.test(record.registrationId) &&
    typeof record.payloadKey === 'string' &&
    PAYLOAD_KEY_PATTERN.test(record.payloadKey) &&
    typeof record.stationKey === 'string' &&
    THUMBPRINT_PATTERN.test(record.stationKey) &&
    typeof record.updatedAt === 'number' &&
    Number.isSafeInteger(record.updatedAt) &&
    record.updatedAt >= 0
  );
}

interface StoreFile {
  schemaVersion: 1;
  registrations: Record<string, NativePushRegistration>;
}

export class NativePushRegistrationStore {
  readonly #path: string;

  constructor(homeDir: string) {
    this.#path = join(homeDir, 'security', FILE_NAME);
  }

  #read(): Map<string, NativePushRegistration> {
    let value: unknown;
    try {
      value = readPrivateJsonFile(this.#path, MAX_FILE_BYTES, LABEL);
    } catch {
      throw new NativePushRegistrationStoreError();
    }
    const result = new Map<string, NativePushRegistration>();
    if (value === null) return result;
    const file = value as Partial<StoreFile> | null;
    if (
      !file ||
      typeof file !== 'object' ||
      Object.keys(file).sort().join(',') !== 'registrations,schemaVersion' ||
      file.schemaVersion !== 1 ||
      !file.registrations ||
      typeof file.registrations !== 'object' ||
      Array.isArray(file.registrations)
    )
      throw new NativePushRegistrationStoreError();
    for (const [deviceId, registration] of Object.entries(file.registrations)) {
      if (!isValidRegistration(registration))
        throw new NativePushRegistrationStoreError();
      result.set(deviceId, { ...registration });
    }
    return result;
  }

  #write(registrations: Map<string, NativePushRegistration>): void {
    const file: StoreFile = {
      schemaVersion: 1,
      registrations: Object.fromEntries(registrations),
    };
    writePrivateJsonFileSync(this.#path, file, MAX_FILE_BYTES, LABEL);
  }

  list(): Map<string, NativePushRegistration> {
    return this.#read();
  }

  /**
   * Stores the device's token. The registrationId and payload key are minted
   * on the first registration and kept across token rotation: they are what
   * the phone checks and decrypts with, so rotating them with the token would
   * make every card in flight during a rotation unreadable.
   */
  upsert(
    deviceId: string,
    request: NativePushRegistrationRequest,
    stationKey: string,
    now: number,
  ): NativePushRegistration {
    const registrations = this.#read();
    const existing = registrations.get(deviceId);
    const registration: NativePushRegistration = {
      token: request.token,
      packageName: request.packageName,
      platform: 'android',
      registrationId:
        existing?.registrationId ??
        randomBytes(RANDOM_ID_BYTES).toString('base64url'),
      payloadKey:
        existing?.payloadKey ??
        randomBytes(PAYLOAD_KEY_BYTES).toString('base64url'),
      stationKey,
      updatedAt: now,
    };
    if (!isValidRegistration(registration))
      throw new NativePushRegistrationStoreError();
    registrations.set(deviceId, registration);
    this.#write(registrations);
    return { ...registration };
  }

  /**
   * Idempotent. With `expectedToken`, deletes only while that token is still
   * the stored one.
   */
  delete(deviceId: string, expectedToken?: string): boolean {
    const registrations = this.#read();
    const current = registrations.get(deviceId);
    if (
      !current ||
      (expectedToken !== undefined && current.token !== expectedToken)
    )
      return false;
    registrations.delete(deviceId);
    this.#write(registrations);
    return true;
  }

  /** Drops every registration whose device is not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    const registrations = this.#read();
    let changed = false;
    for (const deviceId of [...registrations.keys()])
      if (!keep.has(deviceId)) {
        registrations.delete(deviceId);
        changed = true;
      }
    if (changed) this.#write(registrations);
  }
}
