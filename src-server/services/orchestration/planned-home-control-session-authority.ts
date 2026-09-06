import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PAIRING_SCOPE_HOME_CONTROL,
  type PairedDevice,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import { plainDataObject } from './bounded-json.js';
import {
  pairedHomeRef,
  personalControllerTenantId,
} from './personal-home-authority-identity.js';
import {
  plannedHomeAdmissionIdentifier as identifier,
  PLANNED_HOME_ADMISSION_SCHEMA_SQL,
  type PlannedHomeAdmissionRecord,
  readPlannedHomeAdmissionJournal,
} from './planned-home-admission-schema.js';
import {
  createPlannedHomeAdmissionStore,
  type PlannedHomeAdmissionStoreResult,
} from './planned-home-admission-store.js';
import {
  MAX_PLANNED_HOME_CONTROL_SESSIONS,
  PLANNED_HOME_CONTROL_SESSION_SCHEMA_SQL,
  type PlannedHomeControlSessionRecord,
  plannedHomeControlSessionRecordValid,
  readPlannedHomeControlSessionJournal,
} from './planned-home-control-session-schema.js';
import {
  assertDurableHomeTransferDatabase,
  type HomeTransferDurableDatabase,
  readPlannedHomeOwner,
} from './planned-home-transfer-store.js';

export type PlannedHomeControlPrincipal = Readonly<
  Pick<
    RuntimeAuthenticatedRequestPrincipal,
    'credential' | 'authority' | 'deviceId'
  >
>;

/** Memory-only bearer. Persist only its digest in controller storage. */
export interface PlannedHomeControlCapability {
  readonly homeRef: string;
  readonly openId: string;
  readonly generation: number;
  readonly token: string;
}

export type PlannedHomeControlOpenInput =
  | { openId: string; replaySecret: string }
  | { openId: string; existingCapability: PlannedHomeControlCapability };

export type PlannedHomeControlResult<T> =
  | { kind: 'stored'; value: T }
  | {
      kind:
        | 'conflict'
        | 'not-found'
        | 'unavailable'
        | 'denied'
        | 'recovery-required'
        | 'admission-pending';
    };

export type PlannedHomeControlAdmissionBeginResult =
  | {
      kind: 'begun';
      value: PlannedHomeAdmissionRecord & { state: 'unresolved' };
    }
  | {
      kind: 'settled';
      value: PlannedHomeAdmissionRecord & {
        state: 'finished';
        receiptDigest: string;
      };
    }
  | Exclude<
      PlannedHomeAdmissionStoreResult<never>,
      { kind: 'stored'; value: never }
    >;

export interface PlannedHomeControlAdmissionPort {
  /** A settled result is historical replay and never permission for an effect. */
  begin(input: {
    admissionId: string;
    intentDigest: string;
  }): PlannedHomeControlAdmissionBeginResult;
  /** Call only after the local effect owner verified its durable receipt. */
  finish(input: {
    admissionId: string;
    intentDigest: string;
    receiptDigest: string;
  }): PlannedHomeAdmissionStoreResult<PlannedHomeAdmissionRecord>;
}

export interface PlannedHomeControlSessionAuthorityOptions {
  readonly database: HomeTransferDurableDatabase;
  readonly security: Pick<
    EnvironmentSecurityService,
    'identifyDevice' | 'verifyOperatorCredential' | 'devicePairing'
  >;
  readonly controllerEnvironmentId: string;
}

const TOKEN = /^[a-f0-9]{64}$/;

function controllerIdentity(value: unknown): value is string {
  return identifier(value) && Buffer.byteLength(value) <= 200;
}

function dataExact(value: unknown, keys: string[]): boolean {
  try {
    return (
      plainDataObject(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key))
    );
  } catch {
    return false;
  }
}

function capabilityValid(
  value: unknown,
): value is PlannedHomeControlCapability {
  return (
    dataExact(value, ['homeRef', 'openId', 'generation', 'token']) &&
    identifier((value as PlannedHomeControlCapability).homeRef) &&
    identifier((value as PlannedHomeControlCapability).openId) &&
    Number.isSafeInteger((value as PlannedHomeControlCapability).generation) &&
    (value as PlannedHomeControlCapability).generation > 0 &&
    TOKEN.test((value as PlannedHomeControlCapability).token)
  );
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function digestMatches(token: string, expected: string): boolean {
  const actualBytes = Buffer.from(tokenDigest(token), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

class ControlAuthorizationDenied extends Error {}

export function createPlannedHomeControlSessionAuthority(
  options: PlannedHomeControlSessionAuthorityOptions,
) {
  const { database, security } = options;
  const controllerEnvironmentId = options.controllerEnvironmentId;
  if (!controllerIdentity(controllerEnvironmentId))
    throw new Error('A bounded controller environment identity is required');
  const tenantId = personalControllerTenantId(controllerEnvironmentId);
  const retainedCapabilities = new Map<
    string,
    { generation: number; token: string }
  >();

  assertDurableHomeTransferDatabase(database);
  database.exec(PLANNED_HOME_ADMISSION_SCHEMA_SQL);
  database.exec(PLANNED_HOME_CONTROL_SESSION_SCHEMA_SQL);

  function cacheKey(record: PlannedHomeControlSessionRecord): string {
    return `${record.tenantId}\u0000${record.homeRef}`;
  }

  function controllerCurrent(): boolean {
    return security.devicePairing.environmentId() === controllerEnvironmentId;
  }

  function activeControlDevice(deviceId: string): PairedDevice | undefined {
    const device = security.devicePairing
      .listDevices()
      .find(
        (device) =>
          device.id === deviceId &&
          device.revokedAt === null &&
          pairingScopeIncludes(device.scope, PAIRING_SCOPE_HOME_CONTROL),
      );
    return device &&
      security.devicePairing.homeControlGrantRevision(deviceId) !== undefined
      ? device
      : undefined;
  }

  function currentControlDevice(
    principal: PlannedHomeControlPrincipal,
  ): PairedDevice | undefined {
    if (
      principal.authority !== 'device-credential' ||
      !identifier(principal.deviceId)
    )
      return undefined;
    const identified = security.identifyDevice(principal.credential);
    return identified?.id === principal.deviceId
      ? activeControlDevice(principal.deviceId)
      : undefined;
  }

  function operatorCurrent(principal: PlannedHomeControlPrincipal): boolean {
    return (
      controllerCurrent() &&
      principal.authority === 'operator-credential' &&
      security.verifyOperatorCredential(principal.credential)
    );
  }

  function save(record: PlannedHomeControlSessionRecord): void {
    if (!plannedHomeControlSessionRecordValid(record))
      throw new Error('Invalid home control session record');
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > 8192)
      throw new Error('Oversized home control session record');
    database
      .prepare(
        `INSERT INTO planned_home_control_sessions VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,home_ref) DO UPDATE SET
           paired_device_id=excluded.paired_device_id,
           home_control_grant_revision=excluded.home_control_grant_revision,
           open_id=excluded.open_id,
           generation=excluded.generation,
           session_state=excluded.session_state,
           capability_digest=excluded.capability_digest,
           replay_secret_digest=excluded.replay_secret_digest,
           record_json=excluded.record_json`,
      )
      .run(
        record.tenantId,
        record.homeRef,
        record.pairedDeviceId,
        record.homeControlGrantRevision,
        record.openId,
        record.generation,
        record.state,
        record.capabilityDigest,
        record.replaySecretDigest,
        json,
      );
  }

  function transaction<T>(
    authorize: () => boolean,
    run: () => PlannedHomeControlResult<T>,
  ): PlannedHomeControlResult<T> {
    let began = false;
    const check = () => {
      const allowed = authorize();
      if (allowed !== true) {
        void Promise.resolve(allowed).catch(() => {});
        throw new ControlAuthorizationDenied();
      }
    };
    try {
      check();
      database.exec('BEGIN IMMEDIATE');
      began = true;
      assertDurableHomeTransferDatabase(database);
      check();
      const result = run();
      check();
      database.exec('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          database.exec('ROLLBACK');
        } catch {}
      }
      return {
        kind:
          error instanceof ControlAuthorizationDenied
            ? 'denied'
            : 'unavailable',
      };
    }
  }

  function sessionRecord(
    capability: PlannedHomeControlCapability,
  ): PlannedHomeControlSessionRecord | undefined {
    if (!capabilityValid(capability)) return undefined;
    const record = readPlannedHomeControlSessionJournal(database).find(
      (entry) =>
        entry.tenantId === tenantId && entry.homeRef === capability.homeRef,
    );
    if (
      record?.state !== 'active' ||
      record.openId !== capability.openId ||
      record.generation !== capability.generation ||
      !digestMatches(capability.token, record.capabilityDigest) ||
      record.homeRef !== pairedHomeRef(record.pairedDeviceId) ||
      security.devicePairing.homeControlGrantRevision(record.pairedDeviceId) !==
        record.homeControlGrantRevision
    )
      return undefined;
    return record;
  }

  function sessionCurrent(capability: PlannedHomeControlCapability): boolean {
    if (!controllerCurrent()) return false;
    const record = sessionRecord(capability);
    return !!record && activeControlDevice(record.pairedDeviceId) !== undefined;
  }

  return {
    open(
      rawPrincipal: PlannedHomeControlPrincipal,
      rawInput: PlannedHomeControlOpenInput,
    ): PlannedHomeControlResult<{
      capability: PlannedHomeControlCapability;
      replayed: boolean;
    }> {
      const principal = Object.freeze({
        credential: rawPrincipal.credential,
        authority: rawPrincipal.authority,
        deviceId: rawPrincipal.deviceId,
      });
      const hasExistingCapability =
        !!rawInput &&
        typeof rawInput === 'object' &&
        Object.hasOwn(rawInput, 'existingCapability');
      const hasReplaySecret =
        !!rawInput &&
        typeof rawInput === 'object' &&
        Object.hasOwn(rawInput, 'replaySecret');
      if (hasExistingCapability === hasReplaySecret)
        return { kind: 'conflict' };
      const inputKeys = hasExistingCapability
        ? ['openId', 'existingCapability']
        : ['openId', 'replaySecret'];
      if (!dataExact(rawInput, inputKeys) || !identifier(rawInput.openId))
        return { kind: 'conflict' };
      const openId = rawInput.openId;
      const presentedCapability: unknown = hasExistingCapability
        ? (rawInput as { existingCapability: unknown }).existingCapability
        : undefined;
      if (hasExistingCapability && !capabilityValid(presentedCapability))
        return { kind: 'conflict' };
      const existingCapability = capabilityValid(presentedCapability)
        ? Object.freeze({
            homeRef: presentedCapability.homeRef,
            openId: presentedCapability.openId,
            generation: presentedCapability.generation,
            token: presentedCapability.token,
          })
        : undefined;
      const presentedReplaySecret: unknown = hasReplaySecret
        ? (rawInput as { replaySecret: unknown }).replaySecret
        : undefined;
      if (
        hasReplaySecret &&
        (typeof presentedReplaySecret !== 'string' ||
          !TOKEN.test(presentedReplaySecret))
      )
        return { kind: 'conflict' };
      const replaySecret =
        typeof presentedReplaySecret === 'string'
          ? presentedReplaySecret
          : undefined;
      const device = currentControlDevice(principal);
      if (!controllerCurrent() || !device) return { kind: 'denied' };
      const homeControlGrantRevision =
        security.devicePairing.homeControlGrantRevision(device.id);
      if (homeControlGrantRevision === undefined) return { kind: 'denied' };
      const homeRef = pairedHomeRef(device.id);
      let opened:
        | {
            record: PlannedHomeControlSessionRecord;
            token: string;
            replayed: boolean;
          }
        | undefined;
      const result = transaction<{
        capability: PlannedHomeControlCapability;
        replayed: boolean;
      }>(
        () =>
          controllerCurrent() &&
          currentControlDevice(principal) !== undefined &&
          security.devicePairing.homeControlGrantRevision(device.id) ===
            homeControlGrantRevision,
        () => {
          const journal = readPlannedHomeControlSessionJournal(database);
          const admissions = readPlannedHomeAdmissionJournal(database);
          const prior = journal.find(
            (record) =>
              record.tenantId === tenantId && record.homeRef === homeRef,
          );
          if (prior?.state === 'active') {
            if (prior.pairedDeviceId !== device.id || prior.openId !== openId)
              return { kind: 'conflict' };
            if (prior.homeControlGrantRevision !== homeControlGrantRevision)
              return { kind: 'conflict' };
            if (
              existingCapability &&
              (existingCapability.homeRef !== prior.homeRef ||
                existingCapability.openId !== prior.openId ||
                existingCapability.generation !== prior.generation ||
                !digestMatches(
                  existingCapability.token,
                  prior.capabilityDigest,
                ))
            )
              return { kind: 'conflict' };
            const retained = retainedCapabilities.get(cacheKey(prior));
            if (
              replaySecret !== undefined &&
              !digestMatches(replaySecret, prior.replaySecretDigest)
            )
              return { kind: 'conflict' };
            const token =
              existingCapability?.token ??
              (replaySecret !== undefined &&
              retained?.generation === prior.generation
                ? retained.token
                : undefined);
            if (!token || !digestMatches(token, prior.capabilityDigest))
              return { kind: 'recovery-required' };
            opened = { record: prior, token, replayed: true };
            return {
              kind: 'stored',
              value: {
                capability: Object.freeze({
                  homeRef: prior.homeRef,
                  openId: prior.openId,
                  generation: prior.generation,
                  token,
                }),
                replayed: true,
              },
            };
          }
          if (existingCapability) return { kind: 'conflict' };
          if (
            admissions.some(
              (admission) =>
                admission.tenantId === tenantId &&
                admission.homeRef === homeRef &&
                admission.state === 'unresolved',
            )
          )
            return { kind: 'recovery-required' };
          if (prior?.openId === openId) return { kind: 'conflict' };
          if (!prior && journal.length >= MAX_PLANNED_HOME_CONTROL_SESSIONS)
            return { kind: 'conflict' };
          const generation = prior ? prior.generation + 1 : 1;
          if (!Number.isSafeInteger(generation)) return { kind: 'conflict' };
          const token = randomBytes(32).toString('hex');
          const record: PlannedHomeControlSessionRecord = {
            tenantId,
            homeRef,
            pairedDeviceId: device.id,
            homeControlGrantRevision,
            openId,
            generation,
            state: 'active',
            capabilityDigest: tokenDigest(token),
            replaySecretDigest: tokenDigest(replaySecret as string),
          };
          save(record);
          opened = { record, token, replayed: false };
          return {
            kind: 'stored',
            value: {
              capability: Object.freeze({
                homeRef,
                openId: record.openId,
                generation,
                token,
              }),
              replayed: false,
            },
          };
        },
      );
      if (result.kind === 'stored' && opened)
        retainedCapabilities.set(cacheKey(opened.record), {
          generation: opened.record.generation,
          token: opened.token,
        });
      return result;
    },

    bind(
      capability: PlannedHomeControlCapability,
      rawInput: {
        channelId: string;
        ownerRevision: number;
        kind: 'room-write' | 'execution';
        requireSynchronousLocalAuthority: () => boolean;
      },
    ): PlannedHomeControlResult<PlannedHomeControlAdmissionPort> {
      if (
        !capabilityValid(capability) ||
        !dataExact(rawInput, [
          'channelId',
          'ownerRevision',
          'kind',
          'requireSynchronousLocalAuthority',
        ]) ||
        !identifier(rawInput.channelId) ||
        !Number.isSafeInteger(rawInput.ownerRevision) ||
        rawInput.ownerRevision < 0 ||
        (rawInput.kind !== 'room-write' && rawInput.kind !== 'execution') ||
        typeof rawInput.requireSynchronousLocalAuthority !== 'function'
      )
        return { kind: 'conflict' };
      const capturedCapability = Object.freeze({ ...capability });
      const channelId = rawInput.channelId;
      const ownerRevision = rawInput.ownerRevision;
      const kind = rawInput.kind;
      const localAuthority = rawInput.requireSynchronousLocalAuthority;
      const checked = transaction(
        () => sessionCurrent(capturedCapability),
        () => {
          readPlannedHomeAdmissionJournal(database);
          const owner = readPlannedHomeOwner(database, tenantId, channelId);
          return owner?.homeRef === capturedCapability.homeRef &&
            owner.revision === ownerRevision
            ? { kind: 'stored', value: true }
            : { kind: 'conflict' };
        },
      );
      if (checked.kind !== 'stored') return checked;

      const guard = () => {
        if (!sessionCurrent(capturedCapability)) return false;
        const allowed = localAuthority();
        if (allowed !== true) {
          void Promise.resolve(allowed).catch(() => {});
          return false;
        }
        return sessionCurrent(capturedCapability);
      };
      const store = createPlannedHomeAdmissionStore(database, guard);
      const fixed = {
        tenantId,
        channelId,
        ownerRevision,
        homeRef: capturedCapability.homeRef,
        kind,
      };
      const port: PlannedHomeControlAdmissionPort = {
        begin(input) {
          if (
            !dataExact(input, ['admissionId', 'intentDigest']) ||
            !identifier(input.admissionId)
          )
            return { kind: 'conflict' };
          const result = store.begin({ ...fixed, ...input });
          if (result.kind !== 'stored') return result;
          return result.value.state === 'finished'
            ? {
                kind: 'settled',
                value: result.value as PlannedHomeAdmissionRecord & {
                  state: 'finished';
                  receiptDigest: string;
                },
              }
            : {
                kind: 'begun',
                value: result.value as PlannedHomeAdmissionRecord & {
                  state: 'unresolved';
                },
              };
        },
        finish(input) {
          if (
            !dataExact(input, [
              'admissionId',
              'intentDigest',
              'receiptDigest',
            ]) ||
            !identifier(input.admissionId)
          )
            return { kind: 'conflict' };
          return store.finish({ ...fixed, ...input });
        },
      };
      return { kind: 'stored', value: port };
    },

    inspect(
      rawPrincipal: PlannedHomeControlPrincipal,
      rawInput: { deviceId: string },
    ): PlannedHomeControlResult<{
      homeRef: string;
      openId: string;
      generation: number;
      state: 'active' | 'retired';
      unresolvedAdmissionCount: number;
    }> {
      if (!dataExact(rawInput, ['deviceId']) || !identifier(rawInput.deviceId))
        return { kind: 'conflict' };
      const principal = Object.freeze({
        credential: rawPrincipal.credential,
        authority: rawPrincipal.authority,
        deviceId: rawPrincipal.deviceId,
      });
      const homeRef = pairedHomeRef(rawInput.deviceId);
      return transaction<{
        homeRef: string;
        openId: string;
        generation: number;
        state: 'active' | 'retired';
        unresolvedAdmissionCount: number;
      }>(
        () => operatorCurrent(principal),
        () => {
          const sessions = readPlannedHomeControlSessionJournal(database);
          const admissions = readPlannedHomeAdmissionJournal(database);
          const record = sessions.find(
            (entry) => entry.tenantId === tenantId && entry.homeRef === homeRef,
          );
          if (!record) return { kind: 'not-found' };
          return {
            kind: 'stored',
            value: {
              homeRef: record.homeRef,
              openId: record.openId,
              generation: record.generation,
              state: record.state,
              unresolvedAdmissionCount: admissions.filter(
                (admission) =>
                  admission.tenantId === tenantId &&
                  admission.homeRef === homeRef &&
                  admission.state === 'unresolved',
              ).length,
            },
          };
        },
      );
    },

    retire(
      rawPrincipal: PlannedHomeControlPrincipal,
      rawInput: { deviceId: string; expectedGeneration: number },
    ): PlannedHomeControlResult<{
      homeRef: string;
      generation: number;
      state: 'retired';
    }> {
      if (
        !dataExact(rawInput, ['deviceId', 'expectedGeneration']) ||
        !identifier(rawInput.deviceId) ||
        !Number.isSafeInteger(rawInput.expectedGeneration) ||
        rawInput.expectedGeneration <= 0
      )
        return { kind: 'conflict' };
      const principal = Object.freeze({
        credential: rawPrincipal.credential,
        authority: rawPrincipal.authority,
        deviceId: rawPrincipal.deviceId,
      });
      const deviceId = rawInput.deviceId;
      const expectedGeneration = rawInput.expectedGeneration;
      const homeRef = pairedHomeRef(deviceId);
      let retired: PlannedHomeControlSessionRecord | undefined;
      const result = transaction<{
        homeRef: string;
        generation: number;
        state: 'retired';
      }>(
        () => operatorCurrent(principal),
        () => {
          const sessions = readPlannedHomeControlSessionJournal(database);
          const admissions = readPlannedHomeAdmissionJournal(database);
          const record = sessions.find(
            (entry) => entry.tenantId === tenantId && entry.homeRef === homeRef,
          );
          if (!record) return { kind: 'not-found' };
          if (
            record.pairedDeviceId !== deviceId ||
            record.generation !== expectedGeneration
          )
            return { kind: 'conflict' };
          if (
            admissions.some(
              (admission) =>
                admission.tenantId === tenantId &&
                admission.homeRef === homeRef &&
                admission.state === 'unresolved',
            )
          )
            return { kind: 'admission-pending' };
          if (record.state === 'retired')
            return {
              kind: 'stored',
              value: {
                homeRef,
                generation: record.generation,
                state: 'retired',
              },
            };
          retired = { ...record, state: 'retired' };
          save(retired);
          return {
            kind: 'stored',
            value: { homeRef, generation: record.generation, state: 'retired' },
          };
        },
      );
      if (result.kind === 'stored' && retired)
        retainedCapabilities.delete(cacheKey(retired));
      return result;
    },
  };
}
