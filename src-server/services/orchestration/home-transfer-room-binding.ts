import { createHash, randomUUID } from 'node:crypto';
import type { HomeTransferRoomIdentityObservation } from '@kontourai/station-contracts/cloud-move';
import {
  PAIRING_SCOPE_HOME_TRANSFER,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { PeerCredentialStore } from '../peers/peer-credential-store.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import {
  assertDurableHomeTransferDatabase,
  type HomeTransferDurableDatabase,
} from './planned-home-transfer-store.js';

const RECORD_LIMIT_BYTES = 8 * 1024;
const TENANT_PREFIX = 'personal-controller:';

type PeerSnapshot = NonNullable<ReturnType<PeerCredentialStore['get']>>;

export interface HomeTransferRoomBinding {
  readonly tenantId: string;
  readonly channelId: string;
  readonly controllerEnvironmentId: string;
  readonly controllerDeviceId: string;
  readonly remoteEnvironmentId: string;
  readonly remoteTaskId: string;
  readonly remotePairedDeviceId: string;
}

interface StoredHomeTransferRoomBinding extends HomeTransferRoomBinding {
  readonly peerFingerprint: string;
}

export type HomeTransferRoomBindingResult =
  | { readonly kind: 'bound'; readonly binding: HomeTransferRoomBinding }
  | { readonly kind: 'denied' | 'conflict' | 'not-found' | 'unavailable' };

export interface HomeTransferRoomBindingService {
  enroll(
    operatorPrincipal: RuntimeAuthenticatedRequestPrincipal,
    input: {
      readonly channelId: string;
      readonly controllerDeviceId: string;
      readonly remoteEnvironmentId: string;
      readonly remoteTaskId: string;
    },
  ): Promise<HomeTransferRoomBindingResult>;
  resolve(
    principal: RuntimeAuthenticatedRequestPrincipal,
    input: {
      readonly channelId: string;
      readonly controllerDeviceId: string;
    },
  ): Promise<HomeTransferRoomBindingResult>;
}

export interface HomeTransferRoomBindingServiceOptions {
  readonly database: HomeTransferDurableDatabase;
  readonly security: Pick<
    EnvironmentSecurityService,
    'identifyDevice' | 'verifyOperatorCredential' | 'devicePairing'
  >;
  readonly controllerEnvironmentId: string;
  readonly peers: Pick<PeerCredentialStore, 'get'>;
  readonly probe: (
    peer: Readonly<PeerSnapshot>,
    input: Readonly<{ taskId: string; channelId: string; nonce: string }>,
  ) => Promise<unknown>;
}

function exactObject(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key)
  );
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function fingerprint(peer: PeerSnapshot): string {
  // Bind the complete peer-store record. Label/timestamp-only rewrites also
  // invalidate this immutable binding; there is no metadata-only loophole.
  return createHash('sha256')
    .update(
      JSON.stringify([
        peer.environmentId,
        peer.apiBase,
        peer.scope,
        peer.credential,
        peer.label,
        peer.createdAt,
        peer.updatedAt,
      ]),
    )
    .digest('hex');
}

function samePeer(peer: PeerSnapshot | null, expected: string): boolean {
  return peer !== null && fingerprint(peer) === expected;
}

function validObservation(
  value: unknown,
  expected: {
    environmentId: string;
    taskId: string;
    channelId: string;
    nonce: string;
  },
): value is HomeTransferRoomIdentityObservation {
  if (
    !exactObject(value, [
      'schemaVersion',
      'environmentId',
      'pairedDeviceId',
      'taskId',
      'channelId',
      'nonce',
      'executionAuthorityTransferred',
      'executionResumeAvailable',
    ])
  )
    return false;
  const observed = value as HomeTransferRoomIdentityObservation;
  return (
    observed.schemaVersion === 'station.home-transfer-room-identity/v1' &&
    observed.environmentId === expected.environmentId &&
    identifier(observed.pairedDeviceId) &&
    observed.taskId === expected.taskId &&
    observed.channelId === expected.channelId &&
    observed.nonce === expected.nonce &&
    observed.executionAuthorityTransferred === false &&
    observed.executionResumeAvailable === false
  );
}

function validStoredBinding(
  value: unknown,
): value is StoredHomeTransferRoomBinding {
  if (
    !exactObject(value, [
      'tenantId',
      'channelId',
      'controllerEnvironmentId',
      'controllerDeviceId',
      'remoteEnvironmentId',
      'remoteTaskId',
      'remotePairedDeviceId',
      'peerFingerprint',
    ])
  )
    return false;
  const binding = value as StoredHomeTransferRoomBinding;
  return (
    [
      binding.tenantId,
      binding.channelId,
      binding.controllerEnvironmentId,
      binding.controllerDeviceId,
      binding.remoteEnvironmentId,
      binding.remoteTaskId,
      binding.remotePairedDeviceId,
    ].every(identifier) && /^[a-f0-9]{64}$/.test(binding.peerFingerprint)
  );
}

function publicBinding(
  binding: StoredHomeTransferRoomBinding,
): HomeTransferRoomBinding {
  const { peerFingerprint: _privateFingerprint, ...visible } = binding;
  return structuredClone(visible);
}

function sameBinding(
  left: StoredHomeTransferRoomBinding,
  right: StoredHomeTransferRoomBinding,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.channelId === right.channelId &&
    left.controllerEnvironmentId === right.controllerEnvironmentId &&
    left.controllerDeviceId === right.controllerDeviceId &&
    left.remoteEnvironmentId === right.remoteEnvironmentId &&
    left.remoteTaskId === right.remoteTaskId &&
    left.remotePairedDeviceId === right.remotePairedDeviceId &&
    left.peerFingerprint === right.peerFingerprint
  );
}

/**
 * Controller-private durable enrollment for remote room identities. Bindings
 * are immutable in this slice; credential rotation and administrative
 * replacement require a future explicit maintenance operation.
 */
export function createHomeTransferRoomBindingService(
  options: HomeTransferRoomBindingServiceOptions,
): HomeTransferRoomBindingService {
  const { database, security, peers, probe } = options;
  const controllerEnvironmentId = options.controllerEnvironmentId;
  if (!identifier(controllerEnvironmentId))
    throw new Error('Invalid controller environment identity');
  const tenantId = `${TENANT_PREFIX}${controllerEnvironmentId}`;
  if (!identifier(tenantId))
    throw new Error('Invalid controller tenant identity');
  assertDurableHomeTransferDatabase(database);
  database.exec(`CREATE TABLE IF NOT EXISTS home_transfer_room_bindings (
    tenant_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    controller_device_id TEXT NOT NULL,
    remote_environment_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, channel_id, controller_device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_home_transfer_binding_device
    ON home_transfer_room_bindings(tenant_id, controller_device_id);
  CREATE INDEX IF NOT EXISTS idx_home_transfer_binding_remote
    ON home_transfer_room_bindings(tenant_id, remote_environment_id)`);

  function controllerStillFixed(): boolean {
    return security.devicePairing.environmentId() === controllerEnvironmentId;
  }

  function currentParticipant(deviceId: string): boolean {
    const device = security.devicePairing
      .listDevices()
      .find((candidate) => candidate.id === deviceId);
    return (
      device?.revokedAt === null &&
      pairingScopeIncludes(device.scope, PAIRING_SCOPE_HOME_TRANSFER)
    );
  }

  function operatorCurrent(
    principal: RuntimeAuthenticatedRequestPrincipal,
  ): boolean {
    return (
      principal.authority === 'operator-credential' &&
      security.verifyOperatorCredential(principal.credential)
    );
  }

  function participantCurrent(
    principal: RuntimeAuthenticatedRequestPrincipal,
    deviceId: string,
  ): boolean {
    if (
      principal.authority !== 'device-credential' ||
      principal.deviceId !== deviceId
    )
      return false;
    const device = security.identifyDevice(principal.credential);
    return (
      device?.id === deviceId &&
      pairingScopeIncludes(device.scope, PAIRING_SCOPE_HOME_TRANSFER)
    );
  }

  function readBinding(
    channelId: string,
    controllerDeviceId: string,
  ): StoredHomeTransferRoomBinding | undefined {
    const row = database
      .prepare(`SELECT remote_environment_id, CASE
        WHEN length(CAST(record_json AS BLOB)) <= ${RECORD_LIMIT_BYTES}
        THEN record_json END AS record_json
        FROM home_transfer_room_bindings
        WHERE tenant_id=? AND channel_id=? AND controller_device_id=?`)
      .get(tenantId, channelId, controllerDeviceId) as
      | { remote_environment_id?: unknown; record_json?: unknown }
      | undefined;
    if (!row) return undefined;
    if (typeof row.record_json !== 'string')
      throw new Error('Invalid room binding record');
    const parsed = JSON.parse(row.record_json) as unknown;
    if (!validStoredBinding(parsed))
      throw new Error('Invalid room binding record');
    if (
      parsed.tenantId !== tenantId ||
      parsed.channelId !== channelId ||
      parsed.controllerEnvironmentId !== controllerEnvironmentId ||
      parsed.controllerDeviceId !== controllerDeviceId ||
      parsed.remoteEnvironmentId !== row.remote_environment_id
    )
      throw new Error('Invalid room binding identity');
    return parsed;
  }

  async function observe(
    peer: PeerSnapshot,
    input: { channelId: string; remoteTaskId: string },
  ) {
    const snapshot = Object.freeze(structuredClone(peer));
    const observedInput = Object.freeze({
      channelId: input.channelId,
      remoteTaskId: input.remoteTaskId,
    });
    const peerFingerprint = fingerprint(snapshot);
    const nonce = randomUUID();
    let raw: unknown;
    try {
      raw = await probe(snapshot, {
        taskId: observedInput.remoteTaskId,
        channelId: observedInput.channelId,
        nonce,
      });
    } catch {
      return { kind: 'unavailable' as const };
    }
    if (
      !validObservation(raw, {
        environmentId: snapshot.environmentId,
        taskId: observedInput.remoteTaskId,
        channelId: observedInput.channelId,
        nonce,
      })
    )
      return { kind: 'conflict' as const };
    if (!samePeer(peers.get(snapshot.environmentId), peerFingerprint))
      return { kind: 'conflict' as const };
    return {
      kind: 'observed' as const,
      observation: raw,
      peerFingerprint,
    };
  }

  return {
    async enroll(rawOperatorPrincipal, rawInput) {
      const operatorPrincipal = Object.freeze(
        structuredClone(rawOperatorPrincipal),
      );
      const input = Object.freeze({
        channelId: rawInput.channelId,
        controllerDeviceId: rawInput.controllerDeviceId,
        remoteEnvironmentId: rawInput.remoteEnvironmentId,
        remoteTaskId: rawInput.remoteTaskId,
      });
      if (
        ![
          input.channelId,
          input.controllerDeviceId,
          input.remoteEnvironmentId,
          input.remoteTaskId,
        ].every(identifier)
      )
        return { kind: 'conflict' };
      try {
        if (
          !controllerStillFixed() ||
          !operatorCurrent(operatorPrincipal) ||
          !currentParticipant(input.controllerDeviceId)
        )
          return { kind: 'denied' };
        const peer = peers.get(input.remoteEnvironmentId);
        if (!peer) return { kind: 'not-found' };
        if (peer.environmentId === controllerEnvironmentId)
          return { kind: 'conflict' };
        if (!pairingScopeIncludes(peer.scope, PAIRING_SCOPE_HOME_TRANSFER))
          return { kind: 'denied' };
        const observed = await observe(peer, input);
        if (observed.kind !== 'observed') return observed;
        if (
          !controllerStillFixed() ||
          !operatorCurrent(operatorPrincipal) ||
          !currentParticipant(input.controllerDeviceId)
        )
          return { kind: 'denied' };
        if (
          !samePeer(
            peers.get(input.remoteEnvironmentId),
            observed.peerFingerprint,
          )
        )
          return { kind: 'conflict' };
        const binding: StoredHomeTransferRoomBinding = {
          tenantId,
          channelId: input.channelId,
          controllerEnvironmentId,
          controllerDeviceId: input.controllerDeviceId,
          remoteEnvironmentId: input.remoteEnvironmentId,
          remoteTaskId: input.remoteTaskId,
          remotePairedDeviceId: observed.observation.pairedDeviceId,
          peerFingerprint: observed.peerFingerprint,
        };
        const json = JSON.stringify(binding);
        if (Buffer.byteLength(json) > RECORD_LIMIT_BYTES)
          return { kind: 'conflict' };
        let began = false;
        try {
          database.exec('BEGIN IMMEDIATE');
          began = true;
          assertDurableHomeTransferDatabase(database);
          if (
            !controllerStillFixed() ||
            !operatorCurrent(operatorPrincipal) ||
            !currentParticipant(input.controllerDeviceId)
          ) {
            database.exec('ROLLBACK');
            began = false;
            return { kind: 'denied' };
          }
          if (
            !samePeer(
              peers.get(input.remoteEnvironmentId),
              observed.peerFingerprint,
            )
          ) {
            database.exec('ROLLBACK');
            began = false;
            return { kind: 'conflict' };
          }
          const existing = readBinding(
            input.channelId,
            input.controllerDeviceId,
          );
          if (existing) {
            if (
              !controllerStillFixed() ||
              !operatorCurrent(operatorPrincipal) ||
              !currentParticipant(input.controllerDeviceId)
            ) {
              database.exec('ROLLBACK');
              began = false;
              return { kind: 'denied' };
            }
            if (
              !samePeer(
                peers.get(input.remoteEnvironmentId),
                observed.peerFingerprint,
              )
            ) {
              database.exec('ROLLBACK');
              began = false;
              return { kind: 'conflict' };
            }
            database.exec('COMMIT');
            began = false;
            return sameBinding(existing, binding)
              ? { kind: 'bound', binding: publicBinding(existing) }
              : { kind: 'conflict' };
          }
          const alias = database
            .prepare(`SELECT controller_device_id,remote_environment_id
              FROM home_transfer_room_bindings
              WHERE tenant_id=? AND
                (controller_device_id=? OR remote_environment_id=?)`)
            .get(tenantId, input.controllerDeviceId, input.remoteEnvironmentId);
          if (
            alias &&
            ((alias as { controller_device_id?: unknown })
              .controller_device_id !== input.controllerDeviceId ||
              (alias as { remote_environment_id?: unknown })
                .remote_environment_id !== input.remoteEnvironmentId)
          ) {
            database.exec('ROLLBACK');
            began = false;
            return { kind: 'conflict' };
          }
          database
            .prepare(
              'INSERT INTO home_transfer_room_bindings VALUES(?,?,?,?,?)',
            )
            .run(
              tenantId,
              input.channelId,
              input.controllerDeviceId,
              input.remoteEnvironmentId,
              json,
            );
          if (
            !controllerStillFixed() ||
            !operatorCurrent(operatorPrincipal) ||
            !currentParticipant(input.controllerDeviceId)
          ) {
            database.exec('ROLLBACK');
            began = false;
            return { kind: 'denied' };
          }
          if (
            !samePeer(
              peers.get(input.remoteEnvironmentId),
              observed.peerFingerprint,
            )
          ) {
            database.exec('ROLLBACK');
            began = false;
            return { kind: 'conflict' };
          }
          database.exec('COMMIT');
          began = false;
          return { kind: 'bound', binding: publicBinding(binding) };
        } catch {
          if (began) {
            try {
              database.exec('ROLLBACK');
            } catch {}
          }
          return { kind: 'unavailable' };
        }
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async resolve(rawPrincipal, rawInput) {
      const principal = Object.freeze(structuredClone(rawPrincipal));
      const input = Object.freeze({
        channelId: rawInput.channelId,
        controllerDeviceId: rawInput.controllerDeviceId,
      });
      if (![input.channelId, input.controllerDeviceId].every(identifier))
        return { kind: 'conflict' };
      try {
        if (
          !controllerStillFixed() ||
          !currentParticipant(input.controllerDeviceId)
        )
          return { kind: 'denied' };
        if (
          !(
            operatorCurrent(principal) ||
            participantCurrent(principal, input.controllerDeviceId)
          )
        )
          return { kind: 'denied' };
        const binding = readBinding(input.channelId, input.controllerDeviceId);
        if (!binding) return { kind: 'not-found' };
        const peer = peers.get(binding.remoteEnvironmentId);
        if (!peer || !samePeer(peer, binding.peerFingerprint))
          return { kind: 'conflict' };
        if (!pairingScopeIncludes(peer.scope, PAIRING_SCOPE_HOME_TRANSFER))
          return { kind: 'denied' };
        const observed = await observe(peer, {
          channelId: binding.channelId,
          remoteTaskId: binding.remoteTaskId,
        });
        if (observed.kind !== 'observed') return observed;
        if (
          observed.peerFingerprint !== binding.peerFingerprint ||
          observed.observation.pairedDeviceId !== binding.remotePairedDeviceId
        )
          return { kind: 'conflict' };
        const currentBinding = readBinding(
          input.channelId,
          input.controllerDeviceId,
        );
        if (!currentBinding || !sameBinding(currentBinding, binding))
          return { kind: 'conflict' };
        if (
          !controllerStillFixed() ||
          !currentParticipant(input.controllerDeviceId) ||
          !(
            operatorCurrent(principal) ||
            participantCurrent(principal, input.controllerDeviceId)
          )
        )
          return { kind: 'denied' };
        if (
          !samePeer(
            peers.get(binding.remoteEnvironmentId),
            binding.peerFingerprint,
          )
        )
          return { kind: 'conflict' };
        return { kind: 'bound', binding: publicBinding(binding) };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
