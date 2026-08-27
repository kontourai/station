/**
 * VapidKeyService — generates-or-loads the VAPID keypair Station uses to sign
 * Web Push messages, persisted at `~/.station/security/vapid-keys.json`.
 *
 * Mirrors DevicePairingService's private-file persistence pattern: an atomic
 * 0600 write (temp file + fsync + rename) and a paranoid load path that
 * refuses a symlinked, hard-linked, or loosely-permissioned file rather than
 * trusting it.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import webpush from 'web-push';

const VAPID_KEYS_SCHEMA_VERSION = 1 as const;
const VAPID_KEYS_FILE = 'vapid-keys.json';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
// web-push VAPID keys are URL-safe base64: 87 chars (uncompressed P-256 public
// point) and 43 chars (32-byte private scalar), respectively.
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{80,90}$/;
const PRIVATE_KEY_PATTERN = /^[A-Za-z0-9_-]{40,46}$/;

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

interface VapidKeyRecord extends VapidKeyPair {
  schemaVersion: typeof VAPID_KEYS_SCHEMA_VERSION;
}

function validateRecord(value: unknown): VapidKeyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid VAPID key record');
  }
  const record = value as Partial<VapidKeyRecord>;
  if (
    record.schemaVersion !== VAPID_KEYS_SCHEMA_VERSION ||
    typeof record.publicKey !== 'string' ||
    !PUBLIC_KEY_PATTERN.test(record.publicKey) ||
    typeof record.privateKey !== 'string' ||
    !PRIVATE_KEY_PATTERN.test(record.privateKey)
  ) {
    throw new Error('Invalid VAPID key record schema');
  }
  return {
    schemaVersion: VAPID_KEYS_SCHEMA_VERSION,
    publicKey: record.publicKey,
    privateKey: record.privateKey,
  };
}

export class VapidKeyService {
  readonly #securityDir: string;
  readonly #keysPath: string;
  #cached?: VapidKeyPair;

  constructor(homeDir: string) {
    this.#securityDir = join(homeDir, 'security');
    this.#keysPath = join(this.#securityDir, VAPID_KEYS_FILE);
  }

  /** Loads the persisted keypair, generating and persisting one on first use. */
  loadOrCreate(): VapidKeyPair {
    if (this.#cached) return this.#cached;
    mkdirSync(this.#securityDir, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    if (existsSync(this.#keysPath)) {
      this.#cached = this.#readRecord();
      return this.#cached;
    }
    const generated = webpush.generateVAPIDKeys();
    const record: VapidKeyRecord = {
      schemaVersion: VAPID_KEYS_SCHEMA_VERSION,
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    };
    this.#persist(record);
    this.#cached = {
      publicKey: record.publicKey,
      privateKey: record.privateKey,
    };
    return this.#cached;
  }

  #readRecord(): VapidKeyPair {
    const status = lstatSync(this.#keysPath);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (process.platform !== 'win32' &&
        (status.mode & 0o777) !== PRIVATE_FILE_MODE)
    ) {
      throw new Error('Unsafe VAPID key file');
    }
    const record = validateRecord(
      JSON.parse(readFileSync(this.#keysPath, 'utf8')),
    );
    return { publicKey: record.publicKey, privateKey: record.privateKey };
  }

  #persist(record: VapidKeyRecord): void {
    const temporaryPath = join(
      dirname(this.#keysPath),
      `.${VAPID_KEYS_FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      if (process.platform !== 'win32') {
        fchmodSync(descriptor, PRIVATE_FILE_MODE);
      }
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.#keysPath);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }
  }
}
