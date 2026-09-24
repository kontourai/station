/**
 * Native push registrations, in sidecars beside the paired-device registry,
 * keyed by device id: Android (FCM) in `security/native-push-registrations.json`
 * and iOS (Live Activities) in `security/native-push-ios-registrations.json`,
 * both 0600 and schemaVersion 1. One store class serves both files; only the
 * file name and the record check differ.
 *
 * A sidecar and not a field on the device record because the device registry
 * is read with a strict key check: an older Station that finds an unknown
 * field there refuses the whole registry and every paired device with it.
 * An older Station simply never opens this file. iOS records live in a file
 * of their own for the same reason: the Android file is read just as
 * strictly, so one iOS record there would cost an older Station every
 * Android registration.
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
  NATIVE_PUSH_IOS_BUNDLES,
  type NativePushAndroidRegistrationRequest,
  type NativePushIosRegistrationRequest,
  type NativePushRegistrationRequest,
} from '@kontourai/station-contracts/native-push';
import {
  readPrivateJsonFile,
  writePrivateJsonFileSync,
} from './private-json-file.js';

const ANDROID_FILE_NAME = 'native-push-registrations.json';
const ANDROID_LABEL = 'Native push registrations';
const IOS_FILE_NAME = 'native-push-ios-registrations.json';
const IOS_LABEL = 'iOS native push registrations';
const MAX_FILE_BYTES = 512 * 1024;
const RANDOM_ID_BYTES = 16;
const PAYLOAD_KEY_BYTES = 32;
const COMMON_KEYS = [
  'packageName',
  'payloadKey',
  'platform',
  'registrationId',
  'stationKey',
  'token',
  'updatedAt',
];
const ANDROID_KEYS = COMMON_KEYS;
const ANDROID_OPTIONAL_KEYS = ['alerted'];
const IOS_KEYS = [...COMMON_KEYS, 'apnsEnvironment'];
const IOS_OPTIONAL_KEYS = ['activity', 'alerted', 'channelDeletes'];
/** Alert ids remembered per registration; the phone itself keeps 64. */
const ALERTED_MAX = 128;
const ALERT_ID_PATTERN = /^[0-9a-f]{64}$/;
const REGISTRATION_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
/** 32 bytes, base64url without padding. */
const PAYLOAD_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** An ActivityKit push-to-start token: whole bytes, lowercase hex. */
const IOS_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){32,100}$/;
/** An APNs broadcast channel id (base64 as Apple issues it). */
export const APNS_CHANNEL_ID_PATTERN = /^[A-Za-z0-9+/_=-]{8,128}$/;
/**
 * The gateway's proof that a channel was created for this Station's key
 * (`v1.` + base64url HMAC today); opaque to the Station.
 */
export const APNS_CHANNEL_AUTH_PATTERN = /^v\d{1,3}\.[A-Za-z0-9_-]{16,256}$/;
const ACTIVITY_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Channels waiting to be deleted, per registration. */
export const CHANNEL_DELETES_MAX = 16;
/** Retired iOS registrations still to be ended and cleaned up. */
export const TOMBSTONES_MAX = 32;

interface StoredRegistrationFields {
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

export interface NativePushAndroidRegistration
  extends NativePushAndroidRegistrationRequest,
    StoredRegistrationFields {}

/**
 * The Live Activity the Station last started for a registration, and the
 * broadcast channel the gateway created for it inside that start.
 */
export interface NativePushLiveActivityRecord {
  /** When the start was accepted; drives the rollover before Apple's 8 h cap. */
  startedAt: number;
  /** Random per start, so a stale writer cannot clear a newer activity. */
  runId: string;
  channelId: string;
  /** Required by the gateway on every update, end and delete of the channel. */
  channelAuth: string;
  /**
   * The last `timestamp` (s) sent to this activity: kept so a restart never
   * sends it an older one, which the phone would drop.
   */
  lastTimestamp?: number;
}

/**
 * What outlives a removed iOS registration (revoked, unregistered, moved to
 * Android): its live activity, still to be ended at once, and the channels
 * still to be deleted. `payloadKey` is kept only to seal that final empty
 * card; the tombstone goes as soon as both are done.
 */
export interface NativePushIosTombstone {
  registrationId: string;
  payloadKey: string;
  bundleId: NativePushIosRegistrationRequest['packageName'];
  environment: NativePushIosRegistrationRequest['apnsEnvironment'];
  retiredAt: number;
  activity?: NativePushLiveActivityRecord;
  channelDeletes?: NativePushChannelDelete[];
}

/** An ended activity's channel, deleted once its dismissal time has passed. */
export interface NativePushChannelDelete {
  bundleId: NativePushIosRegistrationRequest['packageName'];
  environment: NativePushIosRegistrationRequest['apnsEnvironment'];
  channelId: string;
  channelAuth: string;
  /** Not before this time (ms): the ended activity is still on screen. */
  deleteAt: number;
}

export interface NativePushIosRegistration
  extends NativePushIosRegistrationRequest,
    StoredRegistrationFields {
  activity?: NativePushLiveActivityRecord;
  /** Channels of ended activities not yet deleted; bounded, oldest first. */
  channelDeletes?: NativePushChannelDelete[];
}

export type NativePushRegistration =
  | NativePushAndroidRegistration
  | NativePushIosRegistration;

/** The registration store is present but unreadable; nothing is guessed. */
export class NativePushRegistrationStoreError extends Error {
  constructor(label = ANDROID_LABEL) {
    super(`${label} are unreadable or unsafe`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidAndroidRequest(
  record: Record<string, unknown>,
): record is Record<string, unknown> & NativePushAndroidRegistrationRequest {
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

function isValidIosRequest(
  record: Record<string, unknown>,
): record is Record<string, unknown> & NativePushIosRegistrationRequest {
  return (
    typeof record.token === 'string' &&
    IOS_TOKEN_PATTERN.test(record.token) &&
    typeof record.packageName === 'string' &&
    (NATIVE_PUSH_IOS_BUNDLES as readonly string[]).includes(
      record.packageName,
    ) &&
    (record.apnsEnvironment === 'production' ||
      record.apnsEnvironment === 'sandbox') &&
    record.platform === 'ios'
  );
}

/**
 * The request half, shared by the route and the persisted-record checks so
 * the two cannot disagree about what a registrable token is.
 */
export function isValidNativePushRequest(
  value: unknown,
): value is NativePushRegistrationRequest {
  if (!isRecord(value)) return false;
  return isValidAndroidRequest(value) || isValidIosRequest(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every(
      (key) =>
        (required.includes(key) || optional.includes(key)) &&
        record[key] !== undefined,
    )
  );
}

function hasValidStoredFields(record: Record<string, unknown>): boolean {
  return (
    (record.alerted === undefined ||
      (Array.isArray(record.alerted) &&
        record.alerted.length <= ALERTED_MAX &&
        record.alerted.every(
          (id) => typeof id === 'string' && ALERT_ID_PATTERN.test(id),
        ))) &&
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

function isValidAndroidRegistration(
  value: unknown,
): value is NativePushAndroidRegistration {
  return (
    isRecord(value) &&
    hasExactKeys(value, ANDROID_KEYS, ANDROID_OPTIONAL_KEYS) &&
    isValidAndroidRequest(value) &&
    hasValidStoredFields(value)
  );
}

function isChannelRef(value: Record<string, unknown>): boolean {
  return (
    typeof value.channelId === 'string' &&
    APNS_CHANNEL_ID_PATTERN.test(value.channelId) &&
    typeof value.channelAuth === 'string' &&
    APNS_CHANNEL_AUTH_PATTERN.test(value.channelAuth)
  );
}

function isValidChannelDelete(
  value: unknown,
): value is NativePushChannelDelete {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['bundleId', 'channelAuth', 'channelId', 'deleteAt', 'environment'],
      [],
    ) &&
    isChannelRef(value) &&
    typeof value.bundleId === 'string' &&
    (NATIVE_PUSH_IOS_BUNDLES as readonly string[]).includes(value.bundleId) &&
    (value.environment === 'production' || value.environment === 'sandbox') &&
    typeof value.deleteAt === 'number' &&
    Number.isSafeInteger(value.deleteAt) &&
    value.deleteAt >= 0
  );
}

function isValidActivity(
  value: unknown,
): value is NativePushLiveActivityRecord {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['channelAuth', 'channelId', 'runId', 'startedAt'],
      ['lastTimestamp'],
    ) &&
    (value.lastTimestamp === undefined ||
      (typeof value.lastTimestamp === 'number' &&
        Number.isSafeInteger(value.lastTimestamp) &&
        value.lastTimestamp >= 0)) &&
    isChannelRef(value) &&
    typeof value.startedAt === 'number' &&
    Number.isSafeInteger(value.startedAt) &&
    value.startedAt >= 0 &&
    typeof value.runId === 'string' &&
    ACTIVITY_RUN_ID_PATTERN.test(value.runId)
  );
}

function isValidChannelDeletes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CHANNEL_DELETES_MAX &&
    value.every(isValidChannelDelete)
  );
}

function isValidIosTombstone(value: unknown): value is NativePushIosTombstone {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['bundleId', 'environment', 'payloadKey', 'registrationId', 'retiredAt'],
      ['activity', 'channelDeletes'],
    ) &&
    (value.activity !== undefined || value.channelDeletes !== undefined) &&
    typeof value.registrationId === 'string' &&
    REGISTRATION_ID_PATTERN.test(value.registrationId) &&
    typeof value.payloadKey === 'string' &&
    PAYLOAD_KEY_PATTERN.test(value.payloadKey) &&
    typeof value.bundleId === 'string' &&
    (NATIVE_PUSH_IOS_BUNDLES as readonly string[]).includes(value.bundleId) &&
    (value.environment === 'production' || value.environment === 'sandbox') &&
    typeof value.retiredAt === 'number' &&
    Number.isSafeInteger(value.retiredAt) &&
    value.retiredAt >= 0 &&
    (value.activity === undefined || isValidActivity(value.activity)) &&
    (value.channelDeletes === undefined ||
      isValidChannelDeletes(value.channelDeletes))
  );
}

function retireIos(
  registration: NativePushIosRegistration,
  now: number,
): NativePushIosTombstone | undefined {
  if (!registration.activity && !registration.channelDeletes) return undefined;
  return {
    registrationId: registration.registrationId,
    payloadKey: registration.payloadKey,
    bundleId: registration.packageName,
    environment: registration.apnsEnvironment,
    retiredAt: now,
    ...(registration.activity
      ? { activity: { ...registration.activity } }
      : {}),
    ...(registration.channelDeletes
      ? {
          channelDeletes: registration.channelDeletes.map((entry) => ({
            ...entry,
          })),
        }
      : {}),
  };
}

function isValidIosRegistration(
  value: unknown,
): value is NativePushIosRegistration {
  return (
    isRecord(value) &&
    hasExactKeys(value, IOS_KEYS, IOS_OPTIONAL_KEYS) &&
    isValidIosRequest(value) &&
    hasValidStoredFields(value) &&
    (value.activity === undefined || isValidActivity(value.activity)) &&
    (value.channelDeletes === undefined ||
      isValidChannelDeletes(value.channelDeletes))
  );
}

function clone<R extends NativePushRegistration>(registration: R): R {
  const copy: R = { ...registration };
  if (registration.alerted) copy.alerted = [...registration.alerted];
  if (registration.platform === 'ios') {
    const ios = copy as NativePushIosRegistration;
    if (registration.activity) ios.activity = { ...registration.activity };
    if (registration.channelDeletes)
      ios.channelDeletes = registration.channelDeletes.map((entry) => ({
        ...entry,
      }));
  }
  return copy;
}

function cloneAll<R extends NativePushRegistration>(
  registrations: Map<string, R>,
): Map<string, R> {
  return new Map(
    [...registrations].map(([deviceId, registration]) => [
      deviceId,
      clone(registration),
    ]),
  );
}

interface StoreFile<R> {
  schemaVersion: 1;
  registrations: Record<string, R>;
}

interface RegistrationFileSpec<R extends NativePushRegistration, Q> {
  fileName: string;
  label: string;
  isValid(value: unknown): value is R;
  /** The record for `request`, keeping what `existing` must carry over. */
  build(request: Q, kept: StoredRegistrationFields, existing?: R): R;
  /**
   * What must outlive a removed record (iOS: its live activity and queued
   * channel deletions), or undefined. A file whose spec has no tombstones
   * refuses one that carries any.
   */
  retire?(registration: R, now: number): unknown;
  isValidTombstone?(value: unknown): boolean;
  maxTombstones?: number;
}

/**
 * One sidecar file of registrations. Shared by both platforms so the file
 * handling (strict read, identity-keyed cache, private write) exists once.
 */
class RegistrationFileStore<R extends NativePushRegistration, Q> {
  readonly #path: string;
  readonly #spec: RegistrationFileSpec<R, Q>;
  /**
   * The last good read or write, and the file identity it was taken from.
   * Other processes write this file too (`station environment reset` runs
   * its own pairing service), so a cached value is served only while the
   * file's identity (inode, size, change and modification times) is
   * unchanged — a stat, not a parse. A failed read is never cached.
   */
  #cache:
    | {
        identity: string;
        registrations: Map<string, R>;
        tombstones: readonly unknown[];
      }
    | undefined;
  readonly #now: () => number;
  /** Tombstones dropped for the bound since this store was created. */
  droppedTombstones = 0;

  constructor(
    homeDir: string,
    spec: RegistrationFileSpec<R, Q>,
    now: () => number = Date.now,
  ) {
    this.#path = join(homeDir, 'security', spec.fileName);
    this.#spec = spec;
    this.#now = now;
  }

  #error(): NativePushRegistrationStoreError {
    return new NativePushRegistrationStoreError(this.#spec.label);
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

  protected read(): Map<string, R> {
    return this.readAll().registrations;
  }

  protected readAll(): {
    registrations: Map<string, R>;
    tombstones: unknown[];
  } {
    const identity = this.#identity();
    if (this.#cache?.identity === identity)
      return {
        registrations: cloneAll(this.#cache.registrations),
        tombstones: structuredClone([...this.#cache.tombstones]),
      };
    let value: unknown;
    try {
      value = readPrivateJsonFile(this.#path, MAX_FILE_BYTES, this.#spec.label);
    } catch {
      throw this.#error();
    }
    const result = new Map<string, R>();
    if (value === null) {
      this.#cache = { identity, registrations: new Map(), tombstones: [] };
      return { registrations: result, tombstones: [] };
    }
    const file = value as Partial<StoreFile<R>> | null;
    const keys = file && typeof file === 'object' ? Object.keys(file) : [];
    const tombstones = (file as { tombstones?: unknown } | null)?.tombstones;
    if (
      !file ||
      typeof file !== 'object' ||
      ![
        'registrations,schemaVersion',
        'registrations,schemaVersion,tombstones',
      ].includes(keys.sort().join(',')) ||
      file.schemaVersion !== 1 ||
      !file.registrations ||
      typeof file.registrations !== 'object' ||
      Array.isArray(file.registrations) ||
      (tombstones !== undefined &&
        (!this.#spec.isValidTombstone ||
          !Array.isArray(tombstones) ||
          tombstones.length === 0 ||
          tombstones.length > (this.#spec.maxTombstones ?? 0) ||
          !tombstones.every((entry) => this.#spec.isValidTombstone?.(entry))))
    )
      throw this.#error();
    for (const [deviceId, registration] of Object.entries(file.registrations)) {
      if (!this.#spec.isValid(registration)) throw this.#error();
      result.set(deviceId, clone(registration));
    }
    const kept = (tombstones as unknown[] | undefined) ?? [];
    this.#cache = {
      identity,
      registrations: cloneAll(result),
      tombstones: structuredClone(kept),
    };
    return { registrations: result, tombstones: structuredClone(kept) };
  }

  protected write(registrations: Map<string, R>): void {
    this.writeAll(registrations, this.readAll().tombstones);
  }

  protected writeAll(
    registrations: Map<string, R>,
    tombstones: readonly unknown[],
  ): void {
    for (const registration of registrations.values())
      if (!this.#spec.isValid(registration)) throw this.#error();
    const max = this.#spec.maxTombstones ?? 0;
    const bounded = max > 0 ? tombstones.slice(-max) : [];
    if (max > 0 && tombstones.length > max)
      this.droppedTombstones += tombstones.length - max;
    if (
      bounded.length > 0 &&
      !bounded.every((entry) => this.#spec.isValidTombstone?.(entry))
    )
      throw this.#error();
    const file = {
      schemaVersion: 1,
      registrations: Object.fromEntries(registrations),
      ...(max > 0 && bounded.length > 0 ? { tombstones: bounded } : {}),
    };
    this.#cache = undefined;
    writePrivateJsonFileSync(
      this.#path,
      file,
      MAX_FILE_BYTES,
      this.#spec.label,
    );
    this.#cache = {
      identity: this.#identity(),
      registrations: cloneAll(registrations),
      tombstones: structuredClone(max > 0 ? [...bounded] : []),
    };
  }

  /** Removed records' tombstones, for the files whose spec keeps them. */
  #retired(removed: R[]): unknown[] {
    const at = this.#now();
    return removed
      .map((registration) => this.#spec.retire?.(registration, at))
      .filter((entry) => entry !== undefined);
  }

  list(): Map<string, R> {
    return this.read();
  }

  /**
   * Stores the device's token. The registrationId and payload key are minted
   * on the first registration and kept across token rotation: they are what
   * the phone checks and decrypts with, so rotating them with the token would
   * make every card in flight during a rotation unreadable.
   */
  upsert(deviceId: string, request: Q, stationKey: string, now: number): R {
    const registrations = this.read();
    const existing = registrations.get(deviceId);
    const registration = this.#spec.build(
      request,
      {
        registrationId:
          existing?.registrationId ??
          randomBytes(RANDOM_ID_BYTES).toString('base64url'),
        payloadKey:
          existing?.payloadKey ??
          randomBytes(PAYLOAD_KEY_BYTES).toString('base64url'),
        stationKey,
        updatedAt: now,
        // The phone keeps its own alert history across token rotation, and
        // so does this record; a new registration starts empty on both sides.
        ...(existing?.alerted ? { alerted: [...existing.alerted] } : {}),
      },
      existing,
    );
    if (!this.#spec.isValid(registration)) throw this.#error();
    registrations.set(deviceId, registration);
    this.write(registrations);
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
    const registrations = this.read();
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
    this.write(registrations);
  }

  /**
   * Idempotent. With `expectedToken`, deletes only while that token is still
   * the stored one.
   */
  delete(deviceId: string, expectedToken?: string): boolean {
    const registrations = this.read();
    const current = registrations.get(deviceId);
    if (
      !current ||
      (expectedToken !== undefined && current.token !== expectedToken)
    )
      return false;
    const { tombstones } = this.readAll();
    registrations.delete(deviceId);
    this.writeAll(registrations, [...tombstones, ...this.#retired([current])]);
    return true;
  }

  /** Drops every registration whose device is not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    const { registrations, tombstones } = this.readAll();
    const removed: R[] = [];
    for (const [deviceId, registration] of [...registrations])
      if (!keep.has(deviceId)) {
        registrations.delete(deviceId);
        removed.push(registration);
      }
    if (removed.length > 0)
      this.writeAll(registrations, [...tombstones, ...this.#retired(removed)]);
  }
}

/** Android (FCM) registrations: `security/native-push-registrations.json`. */
export class NativePushRegistrationStore extends RegistrationFileStore<
  NativePushAndroidRegistration,
  NativePushAndroidRegistrationRequest
> {
  constructor(homeDir: string) {
    super(homeDir, {
      fileName: ANDROID_FILE_NAME,
      label: ANDROID_LABEL,
      isValid: isValidAndroidRegistration,
      build: (request, kept) => ({
        token: request.token,
        packageName: request.packageName,
        platform: 'android',
        ...kept,
      }),
    });
  }
}

/**
 * iOS (Live Activity) registrations:
 * `security/native-push-ios-registrations.json`. Besides the Android fields a
 * record carries its APNs environment, the activity last started (with the
 * channel the gateway created for it) and the channels of ended activities
 * still to delete, so a restart neither starts a duplicate activity nor
 * forgets a channel.
 */
export class NativePushIosRegistrationStore extends RegistrationFileStore<
  NativePushIosRegistration,
  NativePushIosRegistrationRequest
> {
  constructor(homeDir: string, now: () => number = Date.now) {
    super(
      homeDir,
      {
        fileName: IOS_FILE_NAME,
        label: IOS_LABEL,
        isValid: isValidIosRegistration,
        retire: retireIos,
        isValidTombstone: isValidIosTombstone,
        maxTombstones: TOMBSTONES_MAX,
        build: (request, kept, existing) => {
          // An activity belongs to one app and one APNs environment: a token
          // for another bundle or environment cannot reach it, so its channel
          // is queued for deletion (under the topic it was created in).
          const sameTopic =
            existing !== undefined &&
            existing.packageName === request.packageName &&
            existing.apnsEnvironment === request.apnsEnvironment;
          const deletes = [...(existing?.channelDeletes ?? [])];
          if (existing?.activity && !sameTopic)
            deletes.push({
              bundleId: existing.packageName,
              environment: existing.apnsEnvironment,
              channelId: existing.activity.channelId,
              channelAuth: existing.activity.channelAuth,
              deleteAt: kept.updatedAt,
            });
          const bounded = deletes.slice(-CHANNEL_DELETES_MAX);
          return {
            token: request.token,
            packageName: request.packageName,
            platform: 'ios',
            apnsEnvironment: request.apnsEnvironment,
            ...kept,
            ...(sameTopic && existing.activity
              ? { activity: { ...existing.activity } }
              : {}),
            ...(bounded.length > 0 ? { channelDeletes: bounded } : {}),
          };
        },
      },
      now,
    );
  }

  /** Retired registrations still to be ended or cleaned up, oldest first. */
  listTombstones(): NativePushIosTombstone[] {
    return this.readAll().tombstones as NativePushIosTombstone[];
  }

  /** Replaces (or, with null, removes) the tombstone for `registrationId`. */
  updateTombstone(
    registrationId: string,
    next: NativePushIosTombstone | null,
  ): void {
    const { registrations, tombstones } = this.readAll();
    const current = tombstones as NativePushIosTombstone[];
    if (!current.some((entry) => entry.registrationId === registrationId))
      return;
    const updated = current.flatMap((entry) =>
      entry.registrationId !== registrationId ? [entry] : next ? [next] : [],
    );
    this.writeAll(registrations, updated);
  }

  /**
   * Retires an activity whose registration is already gone (it was revoked
   * while the activity's start was in flight): it joins that registration's
   * tombstone, or starts one, to be ended. A start only follows an end that
   * was already sent (steps run in order, and a failed end stops them), so
   * an activity the tombstone already holds is one whose end has gone out —
   * a rollover's — and only its channel still needs deleting.
   */
  retireLiveActivity(tombstone: NativePushIosTombstone): void {
    const { registrations, tombstones } = this.readAll();
    const current = tombstones as NativePushIosTombstone[];
    const existing = current.find(
      (entry) => entry.registrationId === tombstone.registrationId,
    );
    if (!existing) {
      this.writeAll(registrations, [...current, tombstone]);
      return;
    }
    const ended = existing.activity;
    const merged: NativePushIosTombstone = {
      ...existing,
      ...(tombstone.activity ? { activity: tombstone.activity } : {}),
    };
    if (ended && tombstone.activity)
      merged.channelDeletes = [
        ...(existing.channelDeletes ?? []),
        {
          bundleId: existing.bundleId,
          environment: existing.environment,
          channelId: ended.channelId,
          channelAuth: ended.channelAuth,
          deleteAt: tombstone.retiredAt,
        },
      ].slice(-CHANNEL_DELETES_MAX);
    this.writeAll(
      registrations,
      current.map((entry) => (entry === existing ? merged : entry)),
    );
  }

  /**
   * Sets (a value) or clears (null) the registration's activity, and queues
   * or drops channel deletions, in one write. Ignored — returning
   * undefined — once the device holds another registrationId, or when
   * `expectedRunId` no longer names the stored activity.
   */
  updateLiveActivity(
    deviceId: string,
    registrationId: string,
    update: NativePushLiveActivityUpdate,
  ): NativePushIosRegistration | undefined {
    const registrations = this.read();
    const current = registrations.get(deviceId);
    if (!current || current.registrationId !== registrationId) return undefined;
    if (
      update.expectedRunId !== undefined &&
      current.activity?.runId !== update.expectedRunId
    )
      return undefined;
    const next: NativePushIosRegistration = { ...current };
    if (update.activity === null) delete next.activity;
    else if (update.activity !== undefined) next.activity = update.activity;
    let deletes = (current.channelDeletes ?? []).filter(
      (entry) => entry.channelId !== update.dropChannelDelete,
    );
    if (update.queueChannelDelete)
      deletes = [
        ...deletes.filter(
          (entry) => entry.channelId !== update.queueChannelDelete?.channelId,
        ),
        update.queueChannelDelete,
      ].slice(-CHANNEL_DELETES_MAX);
    if (deletes.length > 0) next.channelDeletes = deletes;
    else delete next.channelDeletes;
    registrations.set(deviceId, next);
    this.write(registrations);
    return clone(next);
  }
}

export interface NativePushLiveActivityUpdate {
  activity?: NativePushLiveActivityRecord | null;
  expectedRunId?: string;
  queueChannelDelete?: NativePushChannelDelete;
  /** The channelId of a queued deletion that is done. */
  dropChannelDelete?: string;
}

/** A random id for a newly started activity. */
export function newLiveActivityRunId(): string {
  return randomBytes(RANDOM_ID_BYTES).toString('base64url');
}
