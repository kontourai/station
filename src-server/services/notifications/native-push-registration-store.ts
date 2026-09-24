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
import { lstatSync } from 'node:fs';
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
const REGISTRATION_KEYS_WITH_ALERTED = `alerted,${REGISTRATION_KEYS}`;
/** Alert ids remembered per registration; the phone itself keeps 64. */
const ALERTED_MAX = 128;
const ALERT_ID_PATTERN = /^[0-9a-f]{64}$/;
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
  /**
   * Alert entry ids this phone has already been sent, oldest first and
   * bounded. Persisted so a restart, token rotation or a failed read cannot
   * re-raise a grouped alert whose id the phone has never seen.
   */
  alerted?: string[];
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
    [REGISTRATION_KEYS, REGISTRATION_KEYS_WITH_ALERTED].includes(
      Object.keys(record).sort().join(','),
    ) &&
    (record.alerted === undefined ||
      (Array.isArray(record.alerted) &&
        record.alerted.length <= ALERTED_MAX &&
        record.alerted.every(
          (id) => typeof id === 'string' && ALERT_ID_PATTERN.test(id),
        ))) &&
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

function clone(registration: NativePushRegistration): NativePushRegistration {
  return {
    ...registration,
    ...(registration.alerted ? { alerted: [...registration.alerted] } : {}),
  };
}

function cloneAll(
  registrations: Map<string, NativePushRegistration>,
): Map<string, NativePushRegistration> {
  return new Map(
    [...registrations].map(([deviceId, registration]) => [
      deviceId,
      clone(registration),
    ]),
  );
}

interface StoreFile {
  schemaVersion: 1;
  registrations: Record<string, NativePushRegistration>;
}

export class NativePushRegistrationStore {
  readonly #path: string;
  /**
   * The last good read or write, and the file identity it was taken from.
   * Other processes write this file too (`station environment reset` runs
   * its own pairing service), so a cached value is served only while the
   * file's identity (inode, size, change and modification times) is
   * unchanged — a stat, not a parse. A failed read is never cached.
   */
  #cache:
    | { identity: string; registrations: Map<string, NativePushRegistration> }
    | undefined;

  constructor(homeDir: string) {
    this.#path = join(homeDir, 'security', FILE_NAME);
  }

  #identity(): string {
    try {
      const status = lstatSync(this.#path);
      return `${status.dev}:${status.ino}:${status.size}:${status.mtimeMs}:${status.ctimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      return `unreadable:${Date.now()}:${Math.random()}`;
    }
  }

  #read(): Map<string, NativePushRegistration> {
    const identity = this.#identity();
    if (this.#cache?.identity === identity)
      return cloneAll(this.#cache.registrations);
    let value: unknown;
    try {
      value = readPrivateJsonFile(this.#path, MAX_FILE_BYTES, LABEL);
    } catch {
      throw new NativePushRegistrationStoreError();
    }
    const result = new Map<string, NativePushRegistration>();
    if (value === null) {
      this.#cache = { identity, registrations: new Map() };
      return result;
    }
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
      result.set(deviceId, clone(registration));
    }
    this.#cache = { identity, registrations: cloneAll(result) };
    return result;
  }

  #write(registrations: Map<string, NativePushRegistration>): void {
    const file: StoreFile = {
      schemaVersion: 1,
      registrations: Object.fromEntries(registrations),
    };
    this.#cache = undefined;
    writePrivateJsonFileSync(this.#path, file, MAX_FILE_BYTES, LABEL);
    this.#cache = {
      identity: this.#identity(),
      registrations: cloneAll(registrations),
    };
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
      // The phone keeps its own alert history across token rotation, and so
      // does this record; a new registration starts empty on both sides.
      ...(existing?.alerted ? { alerted: [...existing.alerted] } : {}),
    };
    if (!isValidRegistration(registration))
      throw new NativePushRegistrationStoreError();
    registrations.set(deviceId, registration);
    this.#write(registrations);
    return clone(registration);
  }

  /**
   * Records alert ids delivered to a registration. Ignored when the device
   * has since been re-registered under a different registrationId.
   */
  recordAlerted(
    deviceId: string,
    registrationId: string,
    alertIds: readonly string[],
  ): void {
    if (alertIds.length === 0) return;
    const registrations = this.#read();
    const current = registrations.get(deviceId);
    if (!current || current.registrationId !== registrationId) return;
    const known = current.alerted ?? [];
    const added = alertIds.filter(
      (id) => ALERT_ID_PATTERN.test(id) && !known.includes(id),
    );
    if (added.length === 0) return;
    registrations.set(deviceId, {
      ...current,
      alerted: [...known, ...added].slice(-ALERTED_MAX),
    });
    this.#write(registrations);
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
