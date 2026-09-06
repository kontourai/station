import { createHash } from 'node:crypto';
import type { ProjectTaskRoomScope } from '@kontourai/station-contracts/project-task-room';
import { plainDataObject } from './bounded-json.js';
import {
  plannedHomeAdmissionIdentifier,
  plannedHomeAdmissionRecordValid,
} from './planned-home-admission-schema.js';
import type {
  createPlannedHomeControlSessionAuthority,
  PlannedHomeControlAdmissionPort,
  PlannedHomeControlCapability,
  PlannedHomeControlResult,
} from './planned-home-control-session-authority.js';
import {
  type ProjectTaskRoomWriteAdmissionIdentity,
  type ProjectTaskRoomWriteAdmissionPort,
  projectTaskRoomChannelId,
} from './project-task-room-history.js';

const ROOM_WRITE_ADMISSION_NAMESPACE =
  'station.planned-home-room-write-admission/v1';
const DIGEST = /^[a-f0-9]{64}$/;

type ControlAuthority = Pick<
  ReturnType<typeof createPlannedHomeControlSessionAuthority>,
  'bind'
>;

export interface PlannedHomeControlRoomWriteAdapterOptions {
  readonly control: ControlAuthority;
  readonly capability: PlannedHomeControlCapability;
  readonly channelId: string;
  readonly ownerRevision: number;
  readonly requireSynchronousLocalAuthority: () => boolean;
}

function exact(value: unknown, keys: readonly string[]): boolean {
  return (
    plainDataObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validCapability(
  value: unknown,
): value is PlannedHomeControlCapability {
  return (
    exact(value, ['homeRef', 'openId', 'generation', 'token']) &&
    plannedHomeAdmissionIdentifier(
      (value as PlannedHomeControlCapability).homeRef,
    ) &&
    plannedHomeAdmissionIdentifier(
      (value as PlannedHomeControlCapability).openId,
    ) &&
    Number.isSafeInteger((value as PlannedHomeControlCapability).generation) &&
    (value as PlannedHomeControlCapability).generation > 0 &&
    typeof (value as PlannedHomeControlCapability).token === 'string' &&
    DIGEST.test((value as PlannedHomeControlCapability).token)
  );
}

function validScope(value: unknown): value is ProjectTaskRoomScope {
  return (
    exact(value, ['projectId', 'projectSlug', 'taskId']) &&
    plannedHomeAdmissionIdentifier((value as ProjectTaskRoomScope).projectId) &&
    plannedHomeAdmissionIdentifier(
      (value as ProjectTaskRoomScope).projectSlug,
    ) &&
    plannedHomeAdmissionIdentifier((value as ProjectTaskRoomScope).taskId)
  );
}

function validIdentity(
  value: unknown,
): value is ProjectTaskRoomWriteAdmissionIdentity {
  return (
    exact(value, ['scope', 'channelId', 'proposalId', 'intentDigest']) &&
    validScope((value as ProjectTaskRoomWriteAdmissionIdentity).scope) &&
    plannedHomeAdmissionIdentifier(
      (value as ProjectTaskRoomWriteAdmissionIdentity).channelId,
    ) &&
    plannedHomeAdmissionIdentifier(
      (value as ProjectTaskRoomWriteAdmissionIdentity).proposalId,
    ) &&
    typeof (value as ProjectTaskRoomWriteAdmissionIdentity).intentDigest ===
      'string' &&
    DIGEST.test((value as ProjectTaskRoomWriteAdmissionIdentity).intentDigest)
  );
}

export function plannedHomeControlRoomWriteAdmissionId(
  channelId: string,
  proposalId: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([ROOM_WRITE_ADMISSION_NAMESPACE, channelId, proposalId]),
    )
    .digest('hex');
}

function blocked(
  kind: 'conflict' | 'denied' | 'unavailable',
): ProjectTaskRoomWriteAdmissionPort {
  const port: ProjectTaskRoomWriteAdmissionPort = {
    begin: async () => ({ kind }),
    finish: async () => ({ kind }),
  };
  return Object.freeze(port);
}

function blockedKind(
  result: Exclude<
    PlannedHomeControlResult<unknown>,
    { kind: 'stored'; value: unknown }
  >,
): 'conflict' | 'denied' | 'unavailable' {
  return result.kind === 'conflict'
    ? 'conflict'
    : result.kind === 'denied'
      ? 'denied'
      : 'unavailable';
}

/**
 * Private composition adapter only. Constructing it neither establishes a
 * control session nor exposes room-write authority; it binds an existing
 * capability to one fixed room owner and returns a fail-closed port.
 */
export function createPlannedHomeControlRoomWriteAdmissionAdapter(
  options: PlannedHomeControlRoomWriteAdapterOptions,
): ProjectTaskRoomWriteAdmissionPort {
  const bind = options.control?.bind;
  const capability = validCapability(options.capability)
    ? Object.freeze({
        homeRef: options.capability.homeRef,
        openId: options.capability.openId,
        generation: options.capability.generation,
        token: options.capability.token,
      })
    : undefined;
  const channelId = options.channelId;
  const ownerRevision = options.ownerRevision;
  const localAuthority = options.requireSynchronousLocalAuthority;
  if (
    typeof bind !== 'function' ||
    !capability ||
    !plannedHomeAdmissionIdentifier(channelId) ||
    !Number.isSafeInteger(ownerRevision) ||
    ownerRevision < 0 ||
    typeof localAuthority !== 'function'
  )
    return blocked('unavailable');

  let rawBound: unknown;
  try {
    rawBound = bind.call(options.control, capability, {
      channelId,
      ownerRevision,
      kind: 'room-write',
      requireSynchronousLocalAuthority: localAuthority,
    });
  } catch {
    return blocked('unavailable');
  }
  if (!plainDataObject(rawBound)) {
    if (
      rawBound !== null &&
      (typeof rawBound === 'object' || typeof rawBound === 'function')
    )
      void Promise.resolve(rawBound).catch(() => {});
    return blocked('unavailable');
  }
  if (
    (rawBound.kind === 'stored' && !exact(rawBound, ['kind', 'value'])) ||
    (rawBound.kind !== 'stored' && !exact(rawBound, ['kind']))
  )
    return blocked('unavailable');
  if (
    ![
      'stored',
      'conflict',
      'not-found',
      'unavailable',
      'denied',
      'recovery-required',
      'admission-pending',
    ].includes(rawBound.kind as string)
  )
    return blocked('unavailable');
  const bound = rawBound as ReturnType<ControlAuthority['bind']>;
  if (bound.kind !== 'stored') return blocked(blockedKind(bound));
  const controlPort: PlannedHomeControlAdmissionPort = bound.value;
  let rawBegin: unknown;
  let rawFinish: unknown;
  try {
    rawBegin = controlPort?.begin;
    rawFinish = controlPort?.finish;
  } catch {
    return blocked('unavailable');
  }
  if (
    !controlPort ||
    typeof rawBegin !== 'function' ||
    typeof rawFinish !== 'function'
  )
    return blocked('unavailable');
  const begin = rawBegin.bind(
    controlPort,
  ) as PlannedHomeControlAdmissionPort['begin'];
  const finish = rawFinish.bind(
    controlPort,
  ) as PlannedHomeControlAdmissionPort['finish'];

  function fixedIdentity(identity: unknown):
    | {
        admissionId: string;
        intentDigest: string;
      }
    | undefined {
    if (
      !validIdentity(identity) ||
      identity.channelId !== channelId ||
      projectTaskRoomChannelId(identity.scope) !== channelId
    )
      return undefined;
    return Object.freeze({
      admissionId: plannedHomeControlRoomWriteAdmissionId(
        channelId,
        identity.proposalId,
      ),
      intentDigest: identity.intentDigest,
    });
  }

  const port: ProjectTaskRoomWriteAdmissionPort = {
    async begin(identity) {
      const fixed = fixedIdentity(identity);
      if (!fixed) return { kind: 'conflict' };
      try {
        const result = begin(fixed);
        if (result.kind === 'settled') return { kind: 'conflict' };
        if (result.kind !== 'begun') return { kind: blockedKind(result) };
        const record = result.value;
        return plannedHomeAdmissionRecordValid(record) &&
          record.state === 'unresolved' &&
          record.homeRef === capability.homeRef &&
          record.channelId === channelId &&
          record.ownerRevision === ownerRevision &&
          record.kind === 'room-write' &&
          record.admissionId === fixed.admissionId &&
          record.intentDigest === fixed.intentDigest
          ? { kind: 'admitted' }
          : { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    async finish(input) {
      if (
        !exact(input, [
          'scope',
          'channelId',
          'proposalId',
          'intentDigest',
          'receiptDigest',
        ]) ||
        typeof input.receiptDigest !== 'string' ||
        !DIGEST.test(input.receiptDigest)
      )
        return { kind: 'conflict' };
      const fixed = fixedIdentity({
        scope: input.scope,
        channelId: input.channelId,
        proposalId: input.proposalId,
        intentDigest: input.intentDigest,
      });
      if (!fixed) return { kind: 'conflict' };
      try {
        const result = finish({
          ...fixed,
          receiptDigest: input.receiptDigest,
        });
        if (result.kind !== 'stored') return { kind: blockedKind(result) };
        const record = result.value;
        return plannedHomeAdmissionRecordValid(record) &&
          record.state === 'finished' &&
          record.homeRef === capability.homeRef &&
          record.channelId === channelId &&
          record.ownerRevision === ownerRevision &&
          record.kind === 'room-write' &&
          record.admissionId === fixed.admissionId &&
          record.intentDigest === fixed.intentDigest &&
          record.receiptDigest === input.receiptDigest
          ? { kind: 'finished' }
          : { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
  return Object.freeze(port);
}
