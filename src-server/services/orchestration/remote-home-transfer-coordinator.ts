import { randomUUID } from 'node:crypto';
import type { HomeTransferClosingSeal } from '@kontourai/station-contracts/cloud-move';
import { isProjectTaskRoomCheckpoint } from '@kontourai/station-contracts/project-task-room';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { plainDataObject } from './bounded-json.js';
import {
  createHomeTransferRoomBindingService,
  type HomeTransferBoundOwner,
  type HomeTransferRoomBindingServiceOptions,
  homeTransferPeerFingerprint,
} from './home-transfer-room-binding.js';
import {
  probeHomeTransferRoom,
  readHomeTransferRoomSeal,
} from './home-transfer-room-probe.js';
import {
  createPlannedHomeTransferCoordinator,
  type PlannedHomeTransferCoordinatorResult,
} from './planned-home-transfer-coordinator.js';
import {
  createAuthorizedSqlitePlannedHomeTransferStore,
  type PlannedHomeTransferIntent,
} from './planned-home-transfer-store.js';

const flags = {
  executionAuthorityTransferred: false,
  executionResumeAvailable: false,
} as const;
type SealResult =
  | { kind: 'sealed'; seal: HomeTransferClosingSeal }
  | { kind: 'unsealed' | 'conflict' | 'denied' | 'unavailable' };
const intentKeys = [
  'tenantId',
  'channelId',
  'operationId',
  'sourceHomeRef',
  'targetHomeRef',
  'policyRevision',
  'expectedRevision',
] as const;
function exact(
  value: unknown,
  fields: string[],
): value is Record<string, unknown> {
  return (
    plainDataObject(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key))
  );
}
function validateObservation(
  raw: unknown,
  owner: HomeTransferBoundOwner,
  intent: PlannedHomeTransferIntent,
  nonce: string,
): SealResult {
  const fields = [
    'schemaVersion',
    'environmentId',
    'pairedDeviceId',
    'taskId',
    'channelId',
    'nonce',
    'executionAuthorityTransferred',
    'executionResumeAvailable',
    'kind',
  ];
  if (plainDataObject(raw) && raw.kind === 'sealed') fields.push('seal');
  if (
    !exact(raw, fields) ||
    raw.schemaVersion !== 'station.home-transfer-room-seal/v1' ||
    raw.environmentId !== owner.binding.remoteEnvironmentId ||
    raw.pairedDeviceId !== owner.binding.remotePairedDeviceId ||
    raw.taskId !== owner.binding.remoteTaskId ||
    raw.channelId !== intent.channelId ||
    raw.nonce !== nonce ||
    raw.executionAuthorityTransferred !== false ||
    raw.executionResumeAvailable !== false
  )
    return { kind: 'conflict' };
  if (raw.kind === 'unsealed') return { kind: 'unsealed' };
  if (
    raw.kind !== 'sealed' ||
    !exact(raw.seal, [
      'operationId',
      'sourceHomeRef',
      'targetHomeRef',
      'checkpoint',
      'workingStateDigest',
    ])
  )
    return { kind: 'conflict' };
  const seal = raw.seal;
  if (
    seal.operationId !== intent.operationId ||
    seal.sourceHomeRef !== intent.sourceHomeRef ||
    seal.targetHomeRef !== intent.targetHomeRef ||
    !exact(seal.checkpoint, [
      'channelId',
      'epoch',
      'throughSeq',
      'checkpointDigest',
      'retainedAnchorSeq',
      'retainedAnchorDigest',
    ]) ||
    !isProjectTaskRoomCheckpoint(seal.checkpoint) ||
    seal.checkpoint.channelId !== intent.channelId ||
    typeof seal.workingStateDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(seal.workingStateDigest)
  )
    return { kind: 'conflict' };
  return {
    kind: 'sealed',
    seal: {
      operationId: intent.operationId,
      sourceHomeRef: intent.sourceHomeRef,
      targetHomeRef: intent.targetHomeRef,
      checkpoint: structuredClone(seal.checkpoint),
      workingStateDigest: seal.workingStateDigest,
    },
  };
}

/** Bound network readers only. This cannot seal, copy, unseal, or activate a home. */
export function createRemoteHomeTransferCoordinator(
  options: Omit<HomeTransferRoomBindingServiceOptions, 'probe'> & {
    probe?: HomeTransferRoomBindingServiceOptions['probe'];
    readSeal?: typeof readHomeTransferRoomSeal;
  },
) {
  const bindingService = createHomeTransferRoomBindingService({
    ...options,
    probe: options.probe ?? probeHomeTransferRoom,
  });
  const { database, peers } = options;
  const readSeal = options.readSeal ?? readHomeTransferRoomSeal;
  return {
    async advance(
      principal: RuntimeAuthenticatedRequestPrincipal,
      operationId: string,
    ): Promise<PlannedHomeTransferCoordinatorResult> {
      try {
        const resolved = await bindingService.resolveTransferOwners(
          principal,
          operationId,
        );
        if (resolved.kind === 'committed-operation')
          return resolved.isCurrent()
            ? {
                kind: 'decision-committed',
                decision: resolved.transfer,
                ...flags,
              }
            : { kind: 'denied', ...flags };
        if (resolved.kind !== 'bound-owners')
          return { kind: resolved.kind, ...flags };
        if (!resolved.isCurrent()) return { kind: 'denied', ...flags };
        const expected = Object.freeze(
          structuredClone(resolved.transfer.intent),
        );
        const read = async (
          owner: HomeTransferBoundOwner,
          intent: Readonly<PlannedHomeTransferIntent>,
        ): Promise<SealResult> => {
          if (!intentKeys.every((key) => intent[key] === expected[key]))
            return { kind: 'conflict' };
          if (!resolved.isCurrent()) return { kind: 'denied' };
          const peer = peers.get(owner.binding.remoteEnvironmentId);
          if (
            !peer ||
            homeTransferPeerFingerprint(peer) !== owner.peerFingerprint
          )
            return { kind: 'denied' };
          const snapshot = Object.freeze(structuredClone(peer));
          const nonce = randomUUID();
          const raw = await readSeal(snapshot, {
            taskId: owner.binding.remoteTaskId,
            channelId: expected.channelId,
            operationId: expected.operationId,
            sourceHomeRef: expected.sourceHomeRef,
            targetHomeRef: expected.targetHomeRef,
            nonce,
          });
          if (!resolved.isCurrent()) return { kind: 'denied' };
          return validateObservation(raw, owner, expected, nonce);
        };
        const coordinator = createPlannedHomeTransferCoordinator({
          tenantId: expected.tenantId,
          store: createAuthorizedSqlitePlannedHomeTransferStore(
            database,
            resolved.isCurrent,
          ),
          source: {
            ownerIdentity: resolved.source.binding,
            ensureClosed: (intent) => read(resolved.source, intent),
          },
          target: {
            ownerIdentity: resolved.target.binding,
            readSeal: (intent) => read(resolved.target, intent),
          },
        });
        const result = await coordinator.advance(operationId);
        return resolved.isCurrent() ? result : { kind: 'denied', ...flags };
      } catch {
        return { kind: 'unavailable', ...flags };
      }
    },
  };
}
