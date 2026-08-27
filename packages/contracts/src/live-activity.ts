/**
 * Closed browser projection for the personal Activity live-collaborator roster.
 * It deliberately names published work rather than a client, device, route, or
 * other ambient activity signal.
 */
export const LIVE_ACTIVITY_SCHEMA_VERSION = 'station.live-activity/v1' as const;
export const LIVE_ACTIVITY_MAX_ROOMS = 64;
export const LIVE_ACTIVITY_MAX_PARTICIPANTS = 256;
export const LIVE_ACTIVITY_MAX_CONNECTED_CLIENTS = 256;

export interface LiveActivityRoomProjection {
  readonly schemaVersion: typeof LIVE_ACTIVITY_SCHEMA_VERSION;
  readonly observedAt: number;
  readonly participants: readonly LiveActivityParticipant[];
}
export interface LiveActivityProjection extends LiveActivityRoomProjection {
  readonly connectedClients: number;
}

export interface LiveActivityParticipant {
  /** Opaque per-room actor key; never a device, client, or route identity. */
  readonly id: string;
  readonly actor: {
    readonly kind: 'human' | 'agent';
    readonly label: string;
  };
  readonly scope: {
    readonly projectId: string;
    readonly projectSlug: string;
    readonly taskId: string;
  };
  readonly work: {
    /** Present only for an already-authorized agent-session reference. */
    readonly sessionId?: string;
    readonly runId?: string;
    readonly workName: string;
    readonly workState: 'working' | 'reviewing' | 'blocked';
    readonly startedAt: number;
  };
  /** A current room pane state, only when its target is already visible. */
  readonly watching?: {
    readonly state: 'watching' | 'following';
    readonly targetLabel: string;
  };
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every(
        (descriptor) =>
          descriptor.get === undefined && descriptor.set === undefined,
      )
    );
  } catch {
    return false;
  }
}
function fields(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}
function hasOwn(value: RecordValue, key: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      descriptor.get === undefined &&
      descriptor.set === undefined
    );
  } catch {
    return false;
  }
}
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim()
  );
}
function id(value: unknown): value is string {
  return text(value, 256);
}
function participantId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
}
function epoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function participant(value: unknown): LiveActivityParticipant | undefined {
  if (
    !record(value) ||
    !fields(value, [
      'actor',
      'id',
      'scope',
      'work',
      ...(hasOwn(value, 'watching') ? ['watching'] : []),
    ])
  )
    return undefined;
  if (!participantId(value.id)) return undefined;
  if (
    !record(value.actor) ||
    !fields(value.actor, ['kind', 'label']) ||
    !['human', 'agent'].includes(String(value.actor.kind)) ||
    !text(value.actor.label)
  )
    return undefined;
  if (
    !record(value.scope) ||
    !fields(value.scope, ['projectId', 'projectSlug', 'taskId']) ||
    !id(value.scope.projectId) ||
    !id(value.scope.projectSlug) ||
    !id(value.scope.taskId)
  )
    return undefined;
  if (
    !record(value.work) ||
    !fields(value.work, [
      'workName',
      'workState',
      'startedAt',
      ...(hasOwn(value.work, 'sessionId') ? ['sessionId'] : []),
      ...(hasOwn(value.work, 'runId') ? ['runId'] : []),
    ]) ||
    (hasOwn(value.work, 'sessionId') && !id(value.work.sessionId)) ||
    (hasOwn(value.work, 'runId') &&
      (!id(value.work.runId) || !hasOwn(value.work, 'sessionId'))) ||
    !text(value.work.workName) ||
    !['working', 'reviewing', 'blocked'].includes(
      String(value.work.workState),
    ) ||
    !epoch(value.work.startedAt)
  )
    return undefined;
  if (
    value.actor.kind === 'human' &&
    (hasOwn(value.work, 'sessionId') || hasOwn(value.work, 'runId'))
  )
    return undefined;
  let watching: LiveActivityParticipant['watching'];
  if (hasOwn(value, 'watching')) {
    if (
      !record(value.watching) ||
      !fields(value.watching, ['state', 'targetLabel']) ||
      !['watching', 'following'].includes(String(value.watching.state)) ||
      !text(value.watching.targetLabel)
    )
      return undefined;
    watching = {
      state: value.watching.state as 'watching' | 'following',
      targetLabel: value.watching.targetLabel,
    };
  }
  return {
    id: value.id,
    actor: {
      kind: value.actor.kind as 'human' | 'agent',
      label: value.actor.label,
    },
    scope: {
      projectId: value.scope.projectId,
      projectSlug: value.scope.projectSlug,
      taskId: value.scope.taskId,
    },
    work: {
      ...(typeof value.work.sessionId === 'string'
        ? { sessionId: value.work.sessionId }
        : {}),
      ...(typeof value.work.runId === 'string'
        ? { runId: value.work.runId }
        : {}),
      workName: value.work.workName,
      workState: value.work.workState as 'working' | 'reviewing' | 'blocked',
      startedAt: value.work.startedAt,
    },
    ...(watching ? { watching } : {}),
  };
}

export function parseLiveActivityProjection(
  value: unknown,
): LiveActivityProjection | undefined {
  if (
    !record(value) ||
    !fields(value, [
      'schemaVersion',
      'observedAt',
      'connectedClients',
      'participants',
    ]) ||
    value.schemaVersion !== LIVE_ACTIVITY_SCHEMA_VERSION ||
    !epoch(value.observedAt) ||
    !Number.isSafeInteger(value.connectedClients) ||
    (value.connectedClients as number) < 0 ||
    (value.connectedClients as number) > LIVE_ACTIVITY_MAX_CONNECTED_CLIENTS ||
    !Array.isArray(value.participants) ||
    value.participants.length > LIVE_ACTIVITY_MAX_PARTICIPANTS
  )
    return undefined;
  const participants = value.participants.map(participant);
  if (participants.some((row) => !row)) return undefined;
  return {
    schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
    observedAt: value.observedAt,
    connectedClients: value.connectedClients as number,
    participants: participants as LiveActivityParticipant[],
  };
}
