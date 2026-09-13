import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import { ConnectionProofError } from '@kontourai/station-shared/connection-proof';
import {
  assertExistingSecurityDirectory,
  readEnvironmentSecurityRecord,
} from '@kontourai/station-shared/environment-security-record';
import { mutateJsonFileWithGuardedRead } from '@kontourai/station-shared/json-file-storage';
import { createStationConnectionProofIssuer } from './connection-proof-issuer.js';

interface PrivateRecord {
  schemaVersion: 1;
  stationId: string;
  enrollmentId: string;
  generation: number;
  privateKeyPem: string;
  createdAt: number;
}
interface LoadedKey {
  record: PrivateRecord;
  privateKey: KeyObject;
  descriptor: ApprovedStationConnectionTrust;
}
const MAX_RECORD_BYTES = 8192;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class ConnectionSigningKeyStoreError extends Error {
  constructor(
    readonly code:
      | 'key_store_invalid'
      | 'key_store_missing'
      | 'key_generation_conflict',
  ) {
    super(`Station connection signing key unavailable: ${code}`);
  }
}

/**
 * Station-local custody, not a remote enrollment or authorization endpoint.
 * Callers need existing private-home access. Exporting a descriptor does not
 * approve it at a Device; that ceremony belongs to the Device's trust owner.
 */
export class ConnectionSigningKeyStore {
  readonly #directory: string;
  readonly #path: string;
  constructor(homeDir: string) {
    this.#directory = join(homeDir, 'security');
    this.#path = join(this.#directory, 'connection-signing-key.json');
  }

  #stationId(): string {
    assertExistingSecurityDirectory(this.#directory);
    return readEnvironmentSecurityRecord(
      join(this.#directory, 'environment.json'),
    ).environmentId;
  }

  #load(): LoadedKey | null {
    const stationId = this.#stationId();
    let descriptor: number | undefined;
    let observedFile = false;
    try {
      const link = lstatSync(this.#path);
      observedFile = true;
      if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1)
        throw new Error('invalid file');
      descriptor = openSync(
        this.#path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const status = fstatSync(descriptor);
      if (
        !status.isFile() ||
        status.nlink !== 1 ||
        status.size > MAX_RECORD_BYTES ||
        status.dev !== link.dev ||
        status.ino !== link.ino ||
        (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600)
      )
        throw new Error('invalid file');
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let length = 0;
      while (length <= MAX_RECORD_BYTES) {
        const count = readSync(
          descriptor,
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!count) break;
        length += count;
      }
      if (length > MAX_RECORD_BYTES) throw new Error('oversized file');
      const bytes = buffer.subarray(0, length);
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid record');
      const record = value as PrivateRecord;
      if (
        Object.keys(record).sort().join(',') !==
          'createdAt,enrollmentId,generation,privateKeyPem,schemaVersion,stationId' ||
        record.schemaVersion !== 1 ||
        record.stationId !== stationId ||
        typeof record.enrollmentId !== 'string' ||
        !UUID.test(record.enrollmentId) ||
        !Number.isSafeInteger(record.generation) ||
        record.generation < 1 ||
        !Number.isSafeInteger(record.createdAt) ||
        record.createdAt < 0 ||
        typeof record.privateKeyPem !== 'string' ||
        record.privateKeyPem.length > 4096
      )
        throw new Error('invalid record');
      return this.#materialize(record);
    } catch (error) {
      if (!observedFile && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return null;
      // Parser/crypto exceptions can include private input fragments. Never
      // attach them as a cause or expose the private record in a public error.
      throw new ConnectionSigningKeyStoreError('key_store_invalid');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  #materialize(record: PrivateRecord): LoadedKey {
    const privateKey = createPrivateKey(record.privateKeyPem);
    if (
      privateKey.asymmetricKeyType !== 'ec' ||
      privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    )
      throw new Error('unsupported key');
    const publicKey = createPublicKey(privateKey).export({ format: 'jwk' });
    if (
      publicKey.kty !== 'EC' ||
      publicKey.crv !== 'P-256' ||
      !publicKey.x ||
      !publicKey.y
    )
      throw new Error('unsupported public key');
    return {
      record,
      privateKey,
      descriptor: {
        stationId: record.stationId,
        enrollmentId: record.enrollmentId,
        generation: record.generation,
        signingKey: { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y },
      },
    };
  }

  readDescriptor(): ApprovedStationConnectionTrust | null {
    return this.#load()?.descriptor ?? null;
  }

  #newRecord(
    stationId: string,
    enrollmentId: string,
    generation: number,
  ): PrivateRecord {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return {
      schemaVersion: 1,
      stationId,
      enrollmentId,
      generation,
      privateKeyPem: keys.privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString(),
      createdAt: Date.now(),
    };
  }

  async #mutate(
    expected?: ApprovedStationConnectionTrust,
  ): Promise<ApprovedStationConnectionTrust> {
    const stationId = this.#stationId();
    const committed = await mutateJsonFileWithGuardedRead<PrivateRecord | null>(
      this.#path,
      null,
      async () => this.#load()?.record ?? null,
      (current) => {
        if (expected === undefined)
          return current ?? this.#newRecord(stationId, randomUUID(), 1);
        if (!current)
          throw new ConnectionSigningKeyStoreError('key_store_missing');
        const publicKey = this.#materialize(current).descriptor.signingKey;
        if (
          current.stationId !== expected.stationId ||
          current.enrollmentId !== expected.enrollmentId ||
          current.generation !== expected.generation ||
          publicKey.x !== expected.signingKey.x ||
          publicKey.y !== expected.signingKey.y ||
          current.generation === Number.MAX_SAFE_INTEGER
        )
          throw new ConnectionSigningKeyStoreError('key_generation_conflict');
        return this.#newRecord(
          stationId,
          current.enrollmentId,
          current.generation + 1,
        );
      },
      {
        maxBytes: MAX_RECORD_BYTES,
        label: 'Station connection signing key',
        beforeCommit: () => {
          if (this.#stationId() !== stationId)
            throw new ConnectionSigningKeyStoreError('key_store_invalid');
        },
      },
    );
    if (!committed)
      throw new ConnectionSigningKeyStoreError('key_store_missing');
    return this.#materialize(committed).descriptor;
  }

  initialize(): Promise<ApprovedStationConnectionTrust> {
    return this.#mutate();
  }
  rotate(
    expected: ApprovedStationConnectionTrust,
  ): Promise<ApprovedStationConnectionTrust> {
    if (
      !expected ||
      !Number.isSafeInteger(expected.generation) ||
      expected.generation < 1 ||
      expected.signingKey?.kty !== 'EC' ||
      expected.signingKey.crv !== 'P-256'
    )
      return Promise.reject(
        new ConnectionSigningKeyStoreError('key_generation_conflict'),
      );
    // Snapshot before yielding to the file lock. A generation alone cannot
    // distinguish a replaced enrollment or another Station at the same path.
    return this.#mutate({
      stationId: expected.stationId,
      enrollmentId: expected.enrollmentId,
      generation: expected.generation,
      signingKey: { ...expected.signingKey },
    });
  }

  /** Reload custody per request; never keep signing with a retired key. */
  createIssuer(authorize: (binding: StationConnectionProofBinding) => boolean) {
    return Object.freeze({
      issue: async (
        binding: StationConnectionProofBinding,
      ): Promise<string> => {
        const snapshot = this.#load();
        if (!snapshot)
          throw new ConnectionSigningKeyStoreError('key_store_missing');
        const issuer = createStationConnectionProofIssuer({
          trust: snapshot.descriptor,
          signingKey: snapshot.privateKey,
          authorize: (value) => {
            if (authorize(value) !== true) return false;
            try {
              const current = this.#load();
              return (
                current?.record.enrollmentId === snapshot.record.enrollmentId &&
                current.record.generation === snapshot.record.generation &&
                current.record.privateKeyPem === snapshot.record.privateKeyPem
              );
            } catch {
              return false;
            }
          },
        });
        try {
          return await issuer.issue(binding);
        } catch {
          throw new ConnectionProofError();
        }
      },
    });
  }
}
