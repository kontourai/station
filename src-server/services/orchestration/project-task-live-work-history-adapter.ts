/** Composition seam for #2914's live projection and #2972's room authority. */

import type {
  ProjectTaskRoomAppendBody,
  ProjectTaskRoomAppendOutcome,
  ProjectTaskRoomAppendReceipt,
  ProjectTaskRoomAuthority,
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
} from '@kontourai/station-contracts/project-task-room';
import { isProjectTaskRoomAppendReceipt } from '@kontourai/station-contracts/project-task-room';
import type {
  DurablePortOutcome,
  LiveWorkActor,
  LiveWorkHistoryIntent,
  LiveWorkPortCloseOutcome,
  LiveWorkRevisionIntent,
  LiveWorkScope,
} from '../../domain/live-work-session.js';

export interface ProjectTaskRoomServerGrantIssuer {
  /**
   * Server-owned issuance/revalidation.  The browser never supplies a room
   * principal, channel, policy revision, or opaque grant.
   */
  issue(input: {
    readonly scope: LiveWorkScope;
    readonly actor: LiveWorkActor;
    readonly capability: ProjectTaskRoomGrantKind;
    /** Immutable initiating request authority selected by the live runtime. */
    readonly requestId: string;
  }): Promise<
    | {
        readonly kind: 'granted';
        readonly grant: ProjectTaskRoomGrant<ProjectTaskRoomGrantKind>;
      }
    | { readonly kind: 'denied' | 'revoked' | 'unavailable' }
  >;
}

export interface ProjectTaskRoomLiveWorkReceipt {
  readonly kind: 'station.project-task-live-work-room-receipt/v1';
  readonly proposalId: string;
  readonly disposition: 'committed' | 'duplicate';
  readonly roomReceipt: ProjectTaskRoomAppendReceipt;
}

/**
 * The only owner that translates live material intents into project/task room
 * history. It has no EventStore/worker/SQLite surface: those remain hidden by
 * ProjectTaskRoomAuthority.
 */
export class ProjectTaskLiveWorkHistoryAdapter {
  readonly asynchronous = true as const;
  readonly #room: ProjectTaskRoomAuthority;
  readonly #grants: ProjectTaskRoomServerGrantIssuer;

  constructor(
    room: ProjectTaskRoomAuthority,
    grants: ProjectTaskRoomServerGrantIssuer,
  ) {
    this.#room = room;
    this.#grants = grants;
  }

  async commit(
    intent: LiveWorkHistoryIntent | LiveWorkRevisionIntent,
  ): Promise<DurablePortOutcome> {
    try {
      const frozen = freezeIntent(intent);
      if (!frozen) return { state: 'indeterminate' };
      const capability = capabilityFor(frozen);
      const issued = await this.#issue(frozen, capability);
      if ('state' in issued) return issued;
      const append = await this.#append(frozen, issued.grant);
      if (append.kind === 'committed' || append.kind === 'duplicate') {
        if (
          !isProjectTaskRoomAppendReceipt(append.receipt) ||
          append.receipt.proposalId !== frozen.intentId
        )
          return { state: 'indeterminate' };
        return {
          state: 'committed',
          receipt: deepFreeze({
            kind: 'station.project-task-live-work-room-receipt/v1',
            proposalId: frozen.intentId,
            disposition: append.kind,
            roomReceipt: deepFreeze(
              cloneOwnData(append.receipt) as ProjectTaskRoomAppendReceipt,
            ),
          } satisfies ProjectTaskRoomLiveWorkReceipt),
        };
      }
      if (append.kind === 'denied')
        return { state: 'refused', reason: 'denied' };
      if (append.kind === 'rejected')
        return { state: 'refused', reason: `rejected:${append.reason}` };
      return { state: 'indeterminate' };
    } catch {
      return { state: 'indeterminate' };
    }
  }

  async close(): Promise<LiveWorkPortCloseOutcome> {
    try {
      const result = await this.#room.close();
      return result.kind === 'closed'
        ? { outcome: 'closed' }
        : result.kind === 'pending'
          ? { outcome: 'pending' }
          : { outcome: 'unavailable' };
    } catch {
      return { outcome: 'unavailable' };
    }
  }

  async #issue(
    intent: LiveWorkHistoryIntent | LiveWorkRevisionIntent,
    capability: 'agent-publish' | 'lifecycle-append' | 'revision-link',
  ): Promise<
    | {
        readonly kind: 'granted';
        readonly grant: ProjectTaskRoomGrant<
          'agent-publish' | 'lifecycle-append' | 'revision-link'
        >;
      }
    | DurablePortOutcome
  > {
    try {
      const result = await this.#grants.issue({
        scope: intent.scope,
        actor: intent.actor,
        capability,
        requestId: intent.requestId,
      });
      if (!result || typeof result !== 'object')
        return { state: 'indeterminate' };
      if (result.kind === 'granted' && validGrant(result.grant, capability))
        return { kind: 'granted', grant: result.grant };
      if (result.kind === 'denied' || result.kind === 'revoked')
        return { state: 'refused', reason: result.kind };
      return { state: 'indeterminate' };
    } catch {
      return { state: 'indeterminate' };
    }
  }

  async #append(
    intent: LiveWorkHistoryIntent | LiveWorkRevisionIntent,
    grant: ProjectTaskRoomGrant<
      'agent-publish' | 'lifecycle-append' | 'revision-link'
    >,
  ): Promise<ProjectTaskRoomAppendOutcome> {
    try {
      const body: ProjectTaskRoomAppendBody =
        intent.kind === 'announce'
          ? {
              kind: 'live-work-started' as const,
              sessionId: intent.work.sessionId,
              ...(intent.work.runId ? { runReference: intent.work.runId } : {}),
            }
          : intent.kind === 'departure'
            ? {
                kind: 'live-work-presence-ended' as const,
                sessionId: intent.work.sessionId,
                reason: intent.presenceReason!,
                ...(intent.work.runId
                  ? { runReference: intent.work.runId }
                  : {}),
              }
            : intent.kind === 'work-finished'
              ? {
                  kind: 'live-work-finished' as const,
                  sessionId: intent.work.sessionId,
                  outcome: intent.finishOutcome!,
                  ...(intent.work.runId
                    ? { runReference: intent.work.runId }
                    : {}),
                  ...(intent.revisionId
                    ? { revisionReference: intent.revisionId }
                    : {}),
                }
              : {
                  kind: 'outcome-link' as const,
                  linkKind: 'revision' as const,
                  reference: intent.revisionId!,
                };
      const outcome = await this.#room.append({
        grant,
        intent: {
          proposalId: intent.intentId,
          occurredAt: new Date(intent.occurredAt).toISOString(),
          correlationId: intent.work.sessionId,
          causationId: intent.requestId,
          body,
        },
      });
      return validAppendOutcome(outcome) ? outcome : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }
}

function validGrant(
  value: unknown,
  expected: 'agent-publish' | 'lifecycle-append' | 'revision-link',
): value is ProjectTaskRoomGrant<
  'agent-publish' | 'lifecycle-append' | 'revision-link'
> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      'station.project-task-room-grant/v1' &&
    (value as { capability?: unknown }).capability === expected &&
    typeof (value as { opaqueToken?: unknown }).opaqueToken === 'string' &&
    (value as { opaqueToken: string }).opaqueToken.length > 0
  );
}

function capabilityFor(
  intent: LiveWorkHistoryIntent | LiveWorkRevisionIntent,
): 'agent-publish' | 'lifecycle-append' | 'revision-link' {
  if (intent.actor.kind === 'agent') return 'agent-publish';
  return intent.kind === 'revision-reference'
    ? 'revision-link'
    : 'lifecycle-append';
}

function freezeIntent(
  value: unknown,
): (LiveWorkHistoryIntent | LiveWorkRevisionIntent) | undefined {
  const cloned = cloneOwnData(value);
  if (!validIntent(cloned)) return undefined;
  return deepFreeze(cloned) as LiveWorkHistoryIntent | LiveWorkRevisionIntent;
}

function cloneOwnData(value: unknown): unknown {
  try {
    if (value === null || typeof value !== 'object')
      return typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
        ? value
        : undefined;
    if (Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      const child = cloneOwnData(descriptor.value);
      if (child === undefined && descriptor.value !== undefined)
        return undefined;
      result[key] = child;
    }
    return result;
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validIntent(value: unknown): boolean {
  if (!plainOwn(value, baseIntentKeys)) return false;
  const intent = value as Record<string, any>;
  if (
    !liveId(intent.intentId) ||
    !roomId(intent.requestId) ||
    !roomId(intent.occurrenceId) ||
    !Number.isSafeInteger(intent.ordinal) ||
    intent.ordinal < 1 ||
    !Number.isSafeInteger(intent.occurredAt) ||
    intent.occurredAt < 0 ||
    !validScope(intent.scope) ||
    !validActor(intent.actor) ||
    !validWork(intent.work)
  )
    return false;
  if (intent.kind === 'revision-reference')
    return revisionId(intent.revisionId);
  if (intent.kind === 'announce') return true;
  if (intent.kind === 'departure')
    return ['departed', 'withdrawn', 'expired'].includes(intent.presenceReason);
  return (
    intent.kind === 'work-finished' &&
    ['completed', 'failed', 'cancelled'].includes(intent.finishOutcome) &&
    (intent.revisionId === undefined || revisionId(intent.revisionId))
  );
}

const baseIntentKeys = [
  'kind',
  'intentId',
  'requestId',
  'occurrenceId',
  'ordinal',
  'scope',
  'actor',
  'work',
  'occurredAt',
] as const;
function plainOwn(value: unknown, required: readonly string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const keys = Reflect.ownKeys(value);
  const kind = (value as Record<string, unknown>).kind;
  const extras =
    kind === 'departure'
      ? ['presenceReason']
      : kind === 'work-finished'
        ? ['finishOutcome', 'revisionId']
        : kind === 'revision-reference'
          ? ['revisionId']
          : [];
  const allowed = [...required, ...extras];
  return (
    keys.every((key) => {
      if (typeof key !== 'string' || !allowed.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    }) && required.every((key) => keys.includes(key))
  );
}
function validScope(value: unknown): boolean {
  return (
    plainOwn(value, [
      'projectId',
      'taskId',
      'surfaceId',
      'sessionId',
      'channelId',
    ]) && Object.values(value as Record<string, unknown>).every(roomId)
  );
}
function validActor(value: unknown): boolean {
  return (
    plainOwn(value, ['actorId', 'kind', 'label']) &&
    roomId((value as any).actorId) &&
    ['human', 'agent'].includes((value as any).kind) &&
    roomId((value as any).label)
  );
}
function validWork(value: unknown): boolean {
  if (
    !plainOwnWithOptional(
      value,
      ['sessionId', 'workName', 'workState', 'startedAt'],
      ['runId'],
    )
  )
    return false;
  const work = value as Record<string, unknown>;
  return (
    roomId(work.sessionId) &&
    (work.runId === undefined || roomId(work.runId)) &&
    roomId(work.workName) &&
    ['working', 'reviewing', 'blocked'].includes(work.workState as string) &&
    Number.isSafeInteger(work.startedAt) &&
    Number(work.startedAt) >= 0
  );
}
function plainOwnWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => {
      if (typeof key !== 'string' || ![...required, ...optional].includes(key))
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    }) && required.every((key) => keys.includes(key))
  );
}
function liveId(value: unknown): boolean {
  return typeof value === 'string' && /^live-work-v6:[0-9a-f]{64}$/.test(value);
}
function revisionId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^revision-evidence-v1:[0-9a-f]{64}$/.test(value)
  );
}
function roomId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validAppendOutcome(
  value: unknown,
): value is ProjectTaskRoomAppendOutcome {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['committed', 'duplicate', 'rejected', 'denied', 'unavailable'].includes(
      (value as { kind?: unknown }).kind as string,
    )
  );
}
