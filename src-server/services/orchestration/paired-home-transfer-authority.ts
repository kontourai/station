import {
  PAIRING_SCOPE_HOME_TRANSFER,
  type PairedDevice,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import {
  createPlannedHomeTransferCoordinator,
  type PlannedHomeTransferCoordinatorOptions,
  type PlannedHomeTransferCoordinatorResult,
} from './planned-home-transfer-coordinator.js';
import {
  createAuthorizedSqlitePlannedHomeTransferStore,
  type PlannedHomeOwner,
  type PlannedHomeTransfer,
  type TransferStoreResult,
} from './planned-home-transfer-store.js';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: Array<string | number>): unknown;
    get(...values: Array<string | number>): unknown;
  };
}

export type PairedHomeTransferPrincipal = Readonly<
  Pick<
    RuntimeAuthenticatedRequestPrincipal,
    'credential' | 'authority' | 'deviceId'
  >
>;

export interface PairedHomeOwnerInitialization {
  readonly channelId: string;
  readonly sourceDeviceId: string;
  readonly policyRevision: string;
}

export interface PairedHomeTransferPreparation {
  readonly channelId: string;
  readonly operationId: string;
  readonly targetDeviceId: string;
  readonly policyRevision: string;
  readonly expectedRevision: number;
}

/** Private trusted owner adapters, never decoded from HTTP or a copied manifest. */
export type PairedHomeTransferOwners = Pick<
  PlannedHomeTransferCoordinatorOptions,
  'source' | 'target'
>;

export interface PairedHomeTransferAuthority {
  advance(
    principal: PairedHomeTransferPrincipal,
    operationId: string,
    owners: PairedHomeTransferOwners,
  ): Promise<PlannedHomeTransferCoordinatorResult>;
  initializeOwner(
    principal: PairedHomeTransferPrincipal,
    input: PairedHomeOwnerInitialization,
  ): TransferStoreResult<PlannedHomeOwner>;
  inspect(
    principal: PairedHomeTransferPrincipal,
    channelId: string,
  ): TransferStoreResult<PlannedHomeOwner>;
  prepare(
    principal: PairedHomeTransferPrincipal,
    input: PairedHomeTransferPreparation,
  ): TransferStoreResult<PlannedHomeTransfer>;
  resolve(
    principal: PairedHomeTransferPrincipal,
    operationId: string,
  ): TransferStoreResult<PlannedHomeTransfer>;
}

export interface PairedHomeTransferAuthorityOptions {
  /** Centrally owned, file-backed SQLite outside every portable Station home. */
  readonly database: Database;
  readonly security: Pick<
    EnvironmentSecurityService,
    'identifyDevice' | 'verifyOperatorCredential' | 'devicePairing'
  >;
  /** Fixed identity captured from the controller's initialized security record. */
  readonly controllerEnvironmentId: string;
}

const PRIVATE_TENANT_PREFIX = 'personal-controller:';
const HOME_REF_PREFIX = 'paired:';

function capturedPrincipal(
  principal: PairedHomeTransferPrincipal,
): PairedHomeTransferPrincipal {
  return Object.freeze({
    credential: principal.credential,
    authority: principal.authority,
    ...(principal.deviceId === undefined
      ? {}
      : { deviceId: principal.deviceId }),
  });
}

function homeRef(deviceId: string): string {
  return `${HOME_REF_PREFIX}${deviceId}`;
}

/**
 * Personal-controller decisions. The private advance method composes trusted
 * source/target owners; public routes expose preparation and reads only.
 * This service issues no leases and never enables execution admission.
 */
export function createPairedHomeTransferAuthority(
  options: PairedHomeTransferAuthorityOptions,
): PairedHomeTransferAuthority {
  const { database, security } = options;
  const controllerEnvironmentId = options.controllerEnvironmentId;
  if (
    typeof controllerEnvironmentId !== 'string' ||
    controllerEnvironmentId.length === 0 ||
    Buffer.byteLength(controllerEnvironmentId) > 200 ||
    Array.from(controllerEnvironmentId).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error('A bounded controller environment identity is required');
  }
  const tenantId = `${PRIVATE_TENANT_PREFIX}${controllerEnvironmentId}`;

  function controllerIsCurrent(): boolean {
    return security.devicePairing.environmentId() === controllerEnvironmentId;
  }

  function activeTransferDevice(deviceId: string): PairedDevice | undefined {
    return security.devicePairing
      .listDevices()
      .find(
        (device) =>
          device.id === deviceId &&
          device.revokedAt === null &&
          pairingScopeIncludes(device.scope, PAIRING_SCOPE_HOME_TRANSFER),
      );
  }

  function currentTransferDevice(
    principal: PairedHomeTransferPrincipal,
  ): PairedDevice | undefined {
    if (
      principal.authority !== 'device-credential' ||
      typeof principal.deviceId !== 'string'
    )
      return undefined;
    const identified = security.identifyDevice(principal.credential);
    if (identified?.id !== principal.deviceId) return undefined;
    return activeTransferDevice(principal.deviceId);
  }

  function operatorAuthorized(principal: PairedHomeTransferPrincipal): boolean {
    return (
      controllerIsCurrent() &&
      principal.authority === 'operator-credential' &&
      security.verifyOperatorCredential(principal.credential)
    );
  }

  function guardedStore(authorize: () => boolean) {
    return createAuthorizedSqlitePlannedHomeTransferStore(database, authorize);
  }

  function unavailable<T>(): TransferStoreResult<T> {
    return { kind: 'unavailable' };
  }

  return {
    async advance(principal, operationId, owners) {
      const flags = {
        executionAuthorityTransferred: false as const,
        executionResumeAvailable: false as const,
      };
      try {
        const actor = capturedPrincipal(principal);
        const source = {
          history: owners.source.history,
          grant: { ...owners.source.grant },
        };
        const target = {
          history: owners.target.history,
          grant: { ...owners.target.grant },
        };
        const callerAuthorized = () =>
          controllerIsCurrent() && currentTransferDevice(actor) !== undefined;
        const found = guardedStore(callerAuthorized).resolve(
          tenantId,
          operationId,
        );
        if (found.kind !== 'stored') return { kind: found.kind, ...flags };
        const intent = Object.freeze({ ...found.value.intent });
        const authorize = () => {
          const caller = currentTransferDevice(actor);
          return (
            controllerIsCurrent() &&
            caller !== undefined &&
            homeRef(caller.id) === intent.sourceHomeRef &&
            activeTransferDevice(
              intent.targetHomeRef.slice(HOME_REF_PREFIX.length),
            ) !== undefined
          );
        };
        if (!authorize()) return { kind: 'denied', ...flags };
        const coordinator = createPlannedHomeTransferCoordinator({
          store: guardedStore(authorize),
          tenantId,
          source,
          target,
        });
        const result = await coordinator.advance(operationId);
        return authorize() ? result : { kind: 'denied', ...flags };
      } catch {
        return { kind: 'unavailable', ...flags };
      }
    },

    initializeOwner(principal, input) {
      try {
        const actor = capturedPrincipal(principal);
        const enrollment = Object.freeze({
          channelId: input.channelId,
          sourceDeviceId: input.sourceDeviceId,
          policyRevision: input.policyRevision,
        });
        const authorize = () =>
          operatorAuthorized(actor) &&
          activeTransferDevice(enrollment.sourceDeviceId) !== undefined;
        const result = guardedStore(authorize).initialize({
          tenantId,
          channelId: enrollment.channelId,
          homeRef: homeRef(enrollment.sourceDeviceId),
          policyRevision: enrollment.policyRevision,
          revision: 0,
        });
        return result.kind === 'stored' && !authorize()
          ? { kind: 'denied' }
          : result;
      } catch {
        return unavailable();
      }
    },

    inspect(principal, channelId) {
      try {
        const actor = capturedPrincipal(principal);
        const capturedChannelId = channelId;
        const authorize = () =>
          controllerIsCurrent() && currentTransferDevice(actor) !== undefined;
        const result = guardedStore(authorize).inspect(
          tenantId,
          capturedChannelId,
        );
        if (result.kind !== 'stored') return result;
        const current = currentTransferDevice(actor);
        return current &&
          result.value.homeRef === homeRef(current.id) &&
          authorize()
          ? result
          : { kind: 'denied' };
      } catch {
        return unavailable();
      }
    },

    prepare(principal, input) {
      try {
        const actor = capturedPrincipal(principal);
        const preparation = Object.freeze({
          channelId: input.channelId,
          operationId: input.operationId,
          targetDeviceId: input.targetDeviceId,
          policyRevision: input.policyRevision,
          expectedRevision: input.expectedRevision,
        });
        const authorize = () => {
          if (!controllerIsCurrent()) return false;
          const source = currentTransferDevice(actor);
          return (
            source !== undefined &&
            source.id !== preparation.targetDeviceId &&
            activeTransferDevice(preparation.targetDeviceId) !== undefined
          );
        };
        const store = guardedStore(authorize);
        const owner = store.inspect(tenantId, preparation.channelId);
        if (owner.kind !== 'stored') return owner;
        const source = currentTransferDevice(actor);
        if (
          !source ||
          owner.value.homeRef !== homeRef(source.id) ||
          !authorize()
        )
          return { kind: 'denied' };
        const intent = Object.freeze({
          tenantId,
          channelId: preparation.channelId,
          operationId: preparation.operationId,
          sourceHomeRef: homeRef(source.id),
          targetHomeRef: homeRef(preparation.targetDeviceId),
          policyRevision: preparation.policyRevision,
          expectedRevision: preparation.expectedRevision,
        });
        const result = store.prepare(intent);
        return result.kind === 'stored' && !authorize()
          ? { kind: 'denied' }
          : result;
      } catch {
        return unavailable();
      }
    },

    resolve(principal, operationId) {
      try {
        const actor = capturedPrincipal(principal);
        const capturedOperationId = operationId;
        const callerAuthorized = () =>
          controllerIsCurrent() && currentTransferDevice(actor) !== undefined;
        const first = guardedStore(callerAuthorized).resolve(
          tenantId,
          capturedOperationId,
        );
        if (first.kind !== 'stored') return first;
        const current = currentTransferDevice(actor);
        if (
          !current ||
          ![
            first.value.intent.sourceHomeRef,
            first.value.intent.targetHomeRef,
          ].includes(homeRef(current.id))
        )
          return { kind: 'denied' };
        const participantsAuthorized = () =>
          callerAuthorized() &&
          activeTransferDevice(
            first.value.intent.sourceHomeRef.slice(HOME_REF_PREFIX.length),
          ) !== undefined &&
          activeTransferDevice(
            first.value.intent.targetHomeRef.slice(HOME_REF_PREFIX.length),
          ) !== undefined;
        const result = guardedStore(participantsAuthorized).resolve(
          tenantId,
          capturedOperationId,
        );
        return result.kind === 'stored' && !participantsAuthorized()
          ? { kind: 'denied' }
          : result;
      } catch {
        return unavailable();
      }
    },
  };
}
