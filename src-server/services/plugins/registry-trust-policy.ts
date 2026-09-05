import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type {
  AppliedRegistryTrustPolicy,
  RegistryTrustConfiguration,
  RegistryTrustPolicyIdentity,
} from '@kontourai/station-contracts/registry-trust';
import {
  observeAppConfigFile,
  withAppConfigMutationAuthority,
} from '../../domain/config-loader-app.js';

const MAX_BYTES = 64 * 1024;
const hash = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const opaque = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}
function record(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return object(value) && Object.keys(value).every((key) => keys.includes(key));
}
function validIdentity(value: unknown): value is RegistryTrustPolicyIdentity {
  if (
    !record(value, ['configured', 'fingerprint', 'profiles']) ||
    typeof value.configured !== 'boolean' ||
    typeof value.fingerprint !== 'string' ||
    !DIGEST.test(value.fingerprint) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 16 ||
    (!value.configured && value.profiles.length !== 0)
  )
    return false;
  const registryKeys = new Set<string>();
  for (const profile of value.profiles) {
    if (
      !record(profile, ['registryKey', 'signatures', 'trustedKeys']) ||
      !opaque(profile.registryKey, 2048) ||
      !['optional', 'required'].includes(profile.signatures as string) ||
      !Array.isArray(profile.trustedKeys) ||
      profile.trustedKeys.length > 16 ||
      registryKeys.has(profile.registryKey)
    )
      return false;
    registryKeys.add(profile.registryKey);
    const keyIds = new Set<string>();
    for (const key of profile.trustedKeys) {
      if (
        !record(key, ['keyId', 'spkiFingerprint']) ||
        typeof key.keyId !== 'string' ||
        !KEY_ID.test(key.keyId) ||
        keyIds.has(key.keyId) ||
        typeof key.spkiFingerprint !== 'string' ||
        !DIGEST.test(key.spkiFingerprint)
      )
        return false;
      keyIds.add(key.keyId);
    }
    if (
      !isDeepStrictEqual(
        profile.trustedKeys.map((key) => key.keyId),
        [...keyIds].sort(ordinal),
      )
    )
      return false;
  }
  return (
    isDeepStrictEqual(
      value.profiles.map((profile) => profile.registryKey),
      [...registryKeys].sort(ordinal),
    ) &&
    hash(
      JSON.stringify({
        configured: value.configured,
        profiles: value.profiles,
      }),
    ) === value.fingerprint &&
    Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES
  );
}
export function registryTrustPolicyIdentity(
  candidate: unknown,
): RegistryTrustPolicyIdentity {
  if (
    candidate !== undefined &&
    (!record(candidate, ['profiles']) ||
      !Array.isArray(candidate.profiles) ||
      candidate.profiles.length > 16)
  )
    throw new Error('Registry trust profiles are invalid');
  const inputs =
    candidate === undefined
      ? []
      : (candidate as { profiles: unknown[] }).profiles;
  const profiles = inputs
    .map((profile) => {
      if (
        !record(profile, ['registryKey', 'signatures', 'trustedEd25519Keys']) ||
        !opaque(profile.registryKey, 2048) ||
        !['optional', 'required'].includes(profile.signatures as string) ||
        !object(profile.trustedEd25519Keys)
      )
        throw new Error('Registry trust profile is invalid');
      const keys = Object.entries(profile.trustedEd25519Keys);
      if (keys.length > 16)
        throw new Error('Registry trust profile exceeds key limit');
      const trustedKeys = keys
        .map(([keyId, value]) => {
          if (
            !KEY_ID.test(keyId) ||
            typeof value !== 'string' ||
            value.length > 16384
          )
            throw new Error('Registry trust key is invalid');
          const key = createPublicKey(value);
          if (key.asymmetricKeyType !== 'ed25519')
            throw new Error('Registry trust requires Ed25519 public keys');
          return {
            keyId,
            spkiFingerprint: hash(key.export({ format: 'der', type: 'spki' })),
          };
        })
        .sort((a, b) => ordinal(a.keyId, b.keyId));
      return {
        registryKey: profile.registryKey,
        signatures: profile.signatures as 'optional' | 'required',
        trustedKeys,
      };
    })
    .sort((a, b) => ordinal(a.registryKey, b.registryKey));
  const value = { configured: candidate !== undefined, profiles };
  const identity = { ...value, fingerprint: hash(JSON.stringify(value)) };
  if (!validIdentity(identity))
    throw new Error('Registry trust identity is invalid or exceeds its limit');
  return identity;
}

export const REGISTRY_TRUST_POLICY_SCHEMA = `CREATE TABLE IF NOT EXISTS registry_trust_policy_decisions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  epoch TEXT NOT NULL UNIQUE,
  identity_json TEXT NOT NULL
);`;
type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: SQLInputValue[]): unknown;
    run(...values: SQLInputValue[]): unknown;
  };
};
export interface RegistryTrustPolicyDecisions {
  read(): AppliedRegistryTrustPolicy | null;
  publish(
    expectedEpoch: string | null,
    identity: RegistryTrustPolicyIdentity,
  ): AppliedRegistryTrustPolicy | null;
}
export class RegistryTrustPolicyConflict extends Error {
  constructor() {
    super(
      'Registry trust policy changed or is awaiting configuration application',
    );
    this.name = 'RegistryTrustPolicyConflict';
  }
}
/** Uses EventStore's existing database and transaction owner. Reads never initialize a decision. */
export function createRegistryTrustPolicyDecisions(
  db: Database,
): RegistryTrustPolicyDecisions {
  const read = (): AppliedRegistryTrustPolicy | null => {
    const row = db
      .prepare(
        'SELECT scope,epoch,identity_json FROM registry_trust_policy_decisions ORDER BY sequence DESC LIMIT 1',
      )
      .get() as
      | { scope?: unknown; epoch?: unknown; identity_json?: unknown }
      | undefined;
    if (!row) return null;
    if (
      !opaque(row.scope, 256) ||
      !opaque(row.epoch, 256) ||
      typeof row.identity_json !== 'string' ||
      Buffer.byteLength(row.identity_json) > MAX_BYTES
    )
      throw new RegistryTrustPolicyConflict();
    const identity: unknown = JSON.parse(row.identity_json);
    if (!validIdentity(identity)) throw new RegistryTrustPolicyConflict();
    return { scope: row.scope, epoch: row.epoch, identity };
  };
  return {
    read,
    publish(expectedEpoch, identity) {
      if (!validIdentity(identity)) throw new RegistryTrustPolicyConflict();
      const serialized = JSON.stringify(identity);
      if (Buffer.byteLength(serialized) > MAX_BYTES)
        throw new RegistryTrustPolicyConflict();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = read();
        if ((current?.epoch ?? null) !== expectedEpoch)
          throw new RegistryTrustPolicyConflict();
        if (current && isDeepStrictEqual(current.identity, identity)) {
          db.exec('COMMIT');
          return current;
        }
        if (!current && !identity.configured) {
          db.exec('COMMIT');
          return null;
        }
        const decision = {
          scope: current?.scope ?? randomUUID(),
          epoch: randomUUID(),
          identity: structuredClone(identity),
        };
        db.prepare(
          'INSERT INTO registry_trust_policy_decisions(scope,epoch,identity_json) VALUES (?,?,?)',
        ).run(decision.scope, decision.epoch, serialized);
        db.exec('COMMIT');
        return decision;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export interface RegistryTrustPolicyApplication {
  readonly __registryTrustPolicyApplication: unique symbol;
}
/** Local applied-configuration adapter. The candidate file is not an applied policy decision. */
export function createLocalRegistryTrustPolicyAuthority(
  home: string,
  decisions: RegistryTrustPolicyDecisions,
) {
  const applications = new WeakMap<
    RegistryTrustPolicyApplication,
    { epoch: string | null; identity: RegistryTrustPolicyIdentity }
  >();
  const observe = async () =>
    registryTrustPolicyIdentity(
      (await observeAppConfigFile(home))?.registryTrust,
    );
  return {
    async captureApplication() {
      const before = decisions.read();
      const identity = await observe();
      const current = decisions.read();
      if ((before?.epoch ?? null) !== (current?.epoch ?? null))
        throw new RegistryTrustPolicyConflict();
      const capability = Object.freeze({}) as RegistryTrustPolicyApplication;
      applications.set(capability, { epoch: current?.epoch ?? null, identity });
      return capability;
    },
    async publishApplied(
      application: RegistryTrustPolicyApplication,
      appliedCandidate: RegistryTrustConfiguration | undefined,
    ) {
      const captured = applications.get(application);
      if (
        !captured ||
        !isDeepStrictEqual(
          registryTrustPolicyIdentity(appliedCandidate),
          captured.identity,
        )
      )
        throw new RegistryTrustPolicyConflict();
      applications.delete(application);
      return withAppConfigMutationAuthority(home, async () => {
        if (!isDeepStrictEqual(await observe(), captured.identity))
          throw new RegistryTrustPolicyConflict();
        return decisions.publish(captured.epoch, captured.identity);
      });
    },
    async current() {
      const before = decisions.read();
      const identity = await observe();
      const current = decisions.read();
      if ((before?.epoch ?? null) !== (current?.epoch ?? null))
        throw new RegistryTrustPolicyConflict();
      if (
        current
          ? !isDeepStrictEqual(current.identity, identity)
          : identity.configured
      )
        throw new RegistryTrustPolicyConflict();
      return current;
    },
  };
}
export type RegistryTrustPolicyAuthority = ReturnType<
  typeof createLocalRegistryTrustPolicyAuthority
>;
