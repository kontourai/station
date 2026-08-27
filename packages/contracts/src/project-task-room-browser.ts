/** Closed browser projection for the Project/Task room transport. */
export const PROJECT_TASK_ROOM_BROWSER_LIVE_SOURCE_SCHEMA_VERSION =
  'station.live-work-session/v6' as const;
export interface ProjectTaskRoomBrowserCapabilities {
  readonly historyRead: boolean;
  readonly messageWrite: boolean;
  readonly live: boolean;
  readonly documentRead: boolean;
  readonly documentWrite: boolean;
  /** Remains false until #3546 installs durable revision resolution. */
  readonly revisionLinks: boolean;
}
export type ProjectTaskRoomBrowserLink = {
  readonly kind:
    | 'run'
    | 'revision'
    | 'proposed-change'
    | 'evidence'
    | 'receipt';
  readonly stableId: string;
  readonly digest: string;
};
export type ProjectTaskRoomBrowserBody =
  | { readonly kind: 'human-message'; readonly text: string }
  | {
      readonly kind: 'live-work-started';
      readonly sessionId: string;
      readonly run?: ProjectTaskRoomBrowserLink;
    }
  | {
      readonly kind: 'live-work-presence-ended';
      readonly sessionId: string;
      readonly reason: 'departed' | 'withdrawn' | 'expired';
      readonly run?: ProjectTaskRoomBrowserLink;
    }
  | {
      readonly kind: 'live-work-finished';
      readonly sessionId: string;
      readonly outcome: 'completed' | 'failed' | 'cancelled';
      readonly run?: ProjectTaskRoomBrowserLink;
      readonly revision?: ProjectTaskRoomBrowserLink;
      readonly outcomeLink?: ProjectTaskRoomBrowserLink;
    }
  | {
      readonly kind: 'outcome-link';
      readonly link: ProjectTaskRoomBrowserLink;
    };
export interface ProjectTaskRoomBrowserRecord {
  readonly actor: { readonly kind: 'human' | 'agent'; readonly label: string };
  readonly sequence: number;
  readonly body: ProjectTaskRoomBrowserBody;
  readonly digests: { readonly proposal: string; readonly checkpoint: string };
  readonly integrity: 'L0';
}
export interface ProjectTaskRoomBrowserCheckpoint {
  readonly throughSeq: number;
  readonly checkpointDigest: string;
  readonly retainedAnchorSeq: number;
  readonly retainedAnchorDigest: string;
}
export type ProjectTaskRoomBrowserDiscovery =
  | {
      readonly kind: 'opened' | 'existing';
      readonly scope: { readonly projectId: string; readonly taskId: string };
      readonly channelId: string;
      readonly assurance: 'L0';
      readonly capabilities: ProjectTaskRoomBrowserCapabilities;
    }
  | { readonly kind: 'not-found' | 'denied' | 'unavailable' };
export type ProjectTaskRoomBrowserHistory =
  | {
      readonly kind: 'available';
      readonly records: readonly ProjectTaskRoomBrowserRecord[];
      readonly checkpoint: ProjectTaskRoomBrowserCheckpoint;
      readonly hasMore: boolean;
      readonly nextCursor?: string;
      readonly integrity: 'L0';
    }
  | {
      readonly kind: 'gap';
      readonly missingThroughSeq: number;
      readonly checkpoint: ProjectTaskRoomBrowserCheckpoint;
      readonly resumeCursor: string;
    }
  | {
      readonly kind: 'stale';
      readonly checkpoint?: ProjectTaskRoomBrowserCheckpoint;
    }
  | {
      readonly kind: 'invalid-cursor' | 'not-found' | 'denied' | 'unavailable';
    };

export interface ProjectTaskRoomBrowserLiveParticipant {
  readonly actor: {
    readonly actorId: string;
    readonly kind: 'human' | 'agent';
    readonly label: string;
  };
  readonly work: {
    readonly sessionId: string;
    readonly runId?: string;
    readonly workName: string;
    readonly workState: 'working' | 'reviewing' | 'blocked';
    readonly startedAt: number;
  };
  readonly publication: 'published' | 'private';
}

/**
 * Joined browser participants renew at one-third of the production room's
 * 30-second live TTL. Keeping the cadence in the browser contract prevents UI
 * hosts from inventing independent lease policy.
 */
export const PROJECT_TASK_ROOM_LIVE_HEARTBEAT_INTERVAL_MS = 10_000;
export interface ProjectTaskRoomBrowserLivePane {
  readonly actorId: string;
  readonly paneId: string;
  readonly state: 'watching' | 'following' | 'paused';
  readonly targetActorId?: string;
  readonly reason?: 'target_departed' | 'expired';
}
export interface ProjectTaskRoomBrowserLiveCursor {
  readonly actorId: string;
  readonly workingRevision: string;
  readonly selection: { readonly anchor: number; readonly focus: number };
  readonly expiresAt: number;
}
export type ProjectTaskRoomBrowserLiveMutationResult =
  | {
      readonly outcome:
        | 'joined'
        | 'refreshed'
        | 'updated'
        | 'cleared'
        | 'departed'
        | 'paused';
    }
  | {
      readonly outcome: 'degraded';
      readonly intentId: string;
      readonly state: 'indeterminate' | 'refused';
    }
  | {
      readonly outcome:
        | 'invalid'
        | 'forbidden'
        | 'unavailable'
        | 'identity_changed'
        | 'capacity_exceeded'
        | 'rate_limited';
    };

/** Allowlisted live projection shared by SDK and UI; no raw wire objects. */
export interface ProjectTaskRoomBrowserLiveSnapshot {
  readonly generation: string;
  readonly viewerActorId: string;
  readonly scope: { readonly projectId: string; readonly taskId: string };
  readonly state: 'active' | 'stale' | 'degraded';
  readonly participants: readonly ProjectTaskRoomBrowserLiveParticipant[];
  readonly panes: readonly ProjectTaskRoomBrowserLivePane[];
  readonly cursors: readonly ProjectTaskRoomBrowserLiveCursor[];
  readonly result?: ProjectTaskRoomBrowserLiveMutationResult;
}

type RecordValue = Record<string, unknown>;
const own = (
  value: unknown,
  fields: readonly string[],
): value is RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return (
      Object.keys(descriptors).length === fields.length &&
      fields.every((field) => {
        const descriptor = descriptors[field];
        return (
          !!descriptor &&
          descriptor.get === undefined &&
          descriptor.set === undefined
        );
      })
    );
  } catch {
    return false;
  }
};
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value === value.trim() &&
  value.length <= 16_384;
const humanText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  new TextEncoder().encode(value).byteLength <= 16 * 1024;
const id = (value: unknown): value is string =>
  text(value) && value.length <= 256;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const cursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(value);
const hasOwn = (value: RecordValue, key: string) => {
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
};

function link(value: unknown): ProjectTaskRoomBrowserLink | undefined {
  if (
    !own(value, ['kind', 'stableId', 'digest']) ||
    !id(value.stableId) ||
    !digest(value.digest) ||
    !['run', 'revision', 'proposed-change', 'evidence', 'receipt'].includes(
      String(value.kind),
    )
  )
    return undefined;
  return {
    kind: value.kind as ProjectTaskRoomBrowserLink['kind'],
    stableId: value.stableId,
    digest: value.digest,
  };
}
function optionalLink(value: RecordValue, name: string) {
  if (!(name in value)) return undefined;
  return link(value[name]);
}
function body(value: unknown): ProjectTaskRoomBrowserBody | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as RecordValue;
  const kind = hasOwn(row, 'kind') ? row.kind : undefined;
  if (
    kind === 'human-message' &&
    own(row, ['kind', 'text']) &&
    humanText(row.text)
  )
    return { kind: 'human-message', text: row.text };
  if (
    kind === 'live-work-started' &&
    own(
      row,
      hasOwn(row, 'run') ? ['kind', 'sessionId', 'run'] : ['kind', 'sessionId'],
    ) &&
    id(row.sessionId)
  ) {
    const run = optionalLink(row, 'run');
    return run || !('run' in row)
      ? {
          kind: 'live-work-started',
          sessionId: row.sessionId,
          ...(run ? { run } : {}),
        }
      : undefined;
  }
  if (
    kind === 'live-work-presence-ended' &&
    own(
      row,
      hasOwn(row, 'run')
        ? ['kind', 'sessionId', 'reason', 'run']
        : ['kind', 'sessionId', 'reason'],
    ) &&
    id(row.sessionId) &&
    ['departed', 'withdrawn', 'expired'].includes(String(row.reason))
  ) {
    const run = optionalLink(row, 'run');
    return run || !('run' in row)
      ? {
          kind: 'live-work-presence-ended',
          sessionId: row.sessionId,
          reason: row.reason as 'departed' | 'withdrawn' | 'expired',
          ...(run ? { run } : {}),
        }
      : undefined;
  }
  if (
    kind === 'live-work-finished' &&
    own(row, [
      'kind',
      'sessionId',
      'outcome',
      ...['run', 'revision', 'outcomeLink'].filter((name) => hasOwn(row, name)),
    ]) &&
    id(row.sessionId) &&
    ['completed', 'failed', 'cancelled'].includes(String(row.outcome))
  ) {
    const run = optionalLink(row, 'run'),
      revision = optionalLink(row, 'revision'),
      outcomeLink = optionalLink(row, 'outcomeLink');
    if (
      (hasOwn(row, 'run') && !run) ||
      (hasOwn(row, 'revision') && !revision) ||
      (hasOwn(row, 'outcomeLink') && !outcomeLink)
    )
      return undefined;
    return {
      kind: 'live-work-finished',
      sessionId: row.sessionId,
      outcome: row.outcome as 'completed' | 'failed' | 'cancelled',
      ...(run ? { run } : {}),
      ...(revision ? { revision } : {}),
      ...(outcomeLink ? { outcomeLink } : {}),
    };
  }
  if (kind === 'outcome-link' && own(row, ['kind', 'link'])) {
    const resolved = link(row.link);
    return resolved ? { kind: 'outcome-link', link: resolved } : undefined;
  }
  return undefined;
}
function checkpoint(
  value: unknown,
): ProjectTaskRoomBrowserCheckpoint | undefined {
  if (
    !own(value, [
      'throughSeq',
      'checkpointDigest',
      'retainedAnchorSeq',
      'retainedAnchorDigest',
    ]) ||
    !integer(value.throughSeq) ||
    !integer(value.retainedAnchorSeq) ||
    value.retainedAnchorSeq > value.throughSeq ||
    !digest(value.checkpointDigest) ||
    !digest(value.retainedAnchorDigest)
  )
    return undefined;
  return {
    throughSeq: value.throughSeq,
    checkpointDigest: value.checkpointDigest,
    retainedAnchorSeq: value.retainedAnchorSeq,
    retainedAnchorDigest: value.retainedAnchorDigest,
  };
}
function record(value: unknown): ProjectTaskRoomBrowserRecord | undefined {
  if (
    !own(value, ['actor', 'sequence', 'body', 'digests', 'integrity']) ||
    !own(value.actor, ['kind', 'label']) ||
    !['human', 'agent'].includes(String(value.actor.kind)) ||
    !text(value.actor.label) ||
    !integer(value.sequence) ||
    value.integrity !== 'L0' ||
    !own(value.digests, ['proposal', 'checkpoint']) ||
    !digest(value.digests.proposal) ||
    !digest(value.digests.checkpoint)
  )
    return undefined;
  const parsed = body(value.body);
  return parsed
    ? {
        actor: {
          kind: value.actor.kind as 'human' | 'agent',
          label: value.actor.label,
        },
        sequence: value.sequence,
        body: parsed,
        digests: {
          proposal: value.digests.proposal,
          checkpoint: value.digests.checkpoint,
        },
        integrity: 'L0',
      }
    : undefined;
}

function liveParticipant(
  value: unknown,
): ProjectTaskRoomBrowserLiveParticipant | undefined {
  if (
    !own(value, ['actor', 'work', 'publication']) ||
    !own(value.actor, ['actorId', 'kind', 'label']) ||
    !id(value.actor.actorId) ||
    !['human', 'agent'].includes(String(value.actor.kind)) ||
    !text(value.actor.label) ||
    !['published', 'private'].includes(String(value.publication))
  )
    return undefined;
  if (
    !value.work ||
    typeof value.work !== 'object' ||
    Array.isArray(value.work)
  )
    return undefined;
  const work = value.work as RecordValue;
  if (
    !own(
      work,
      hasOwn(work, 'runId')
        ? ['sessionId', 'runId', 'workName', 'workState', 'startedAt']
        : ['sessionId', 'workName', 'workState', 'startedAt'],
    ) ||
    !id(work.sessionId) ||
    (hasOwn(work, 'runId') && !id(work.runId)) ||
    !text(work.workName) ||
    !['working', 'reviewing', 'blocked'].includes(String(work.workState)) ||
    !integer(work.startedAt)
  )
    return undefined;
  return {
    actor: {
      actorId: value.actor.actorId,
      kind: value.actor.kind as 'human' | 'agent',
      label: value.actor.label,
    },
    work: {
      sessionId: work.sessionId,
      ...(typeof work.runId === 'string' ? { runId: work.runId } : {}),
      workName: work.workName,
      workState: work.workState as 'working' | 'reviewing' | 'blocked',
      startedAt: work.startedAt,
    },
    publication: value.publication as 'published' | 'private',
  };
}

function livePane(value: unknown): ProjectTaskRoomBrowserLivePane | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as RecordValue;
  const fields = [
    'actorId',
    'paneId',
    'state',
    ...(hasOwn(row, 'targetActorId') ? ['targetActorId'] : []),
    ...(hasOwn(row, 'reason') ? ['reason'] : []),
  ];
  if (
    !(
      own(row, fields) &&
      id(row.actorId) &&
      id(row.paneId) &&
      ['watching', 'following', 'paused'].includes(String(row.state)) &&
      (!hasOwn(row, 'targetActorId') || id(row.targetActorId)) &&
      (!hasOwn(row, 'reason') ||
        ['target_departed', 'expired'].includes(String(row.reason)))
    )
  )
    return undefined;
  return {
    actorId: row.actorId as string,
    paneId: row.paneId as string,
    state: row.state as 'watching' | 'following' | 'paused',
    ...(typeof row.targetActorId === 'string'
      ? { targetActorId: row.targetActorId }
      : {}),
    ...(row.reason === 'target_departed' || row.reason === 'expired'
      ? { reason: row.reason }
      : {}),
  };
}

function validLiveTyping(value: unknown): boolean {
  return (
    own(value, ['actorId', 'expiresAt']) &&
    id(value.actorId) &&
    integer(value.expiresAt)
  );
}

function liveCursor(
  value: unknown,
): ProjectTaskRoomBrowserLiveCursor | undefined {
  if (
    !own(value, ['actorId', 'workingRevision', 'selection', 'expiresAt']) ||
    !id(value.actorId) ||
    !id(value.workingRevision) ||
    !own(value.selection, ['anchor', 'focus']) ||
    !integer(value.selection.anchor) ||
    !integer(value.selection.focus) ||
    !integer(value.expiresAt)
  )
    return undefined;
  return {
    actorId: value.actorId,
    workingRevision: value.workingRevision,
    selection: {
      anchor: value.selection.anchor,
      focus: value.selection.focus,
    },
    expiresAt: value.expiresAt,
  };
}

function liveSnapshot(
  generation: unknown,
  viewerActorId: unknown,
  value: unknown,
  result?: ProjectTaskRoomBrowserLiveMutationResult,
): ProjectTaskRoomBrowserLiveSnapshot | undefined {
  if (
    !id(generation) ||
    !id(viewerActorId) ||
    !own(value, ['outcome', 'snapshot']) ||
    value.outcome !== 'available' ||
    !own(value.snapshot, [
      'schemaVersion',
      'scope',
      'state',
      'participants',
      'panes',
      'cursors',
      'typing',
    ]) ||
    value.snapshot.schemaVersion !==
      PROJECT_TASK_ROOM_BROWSER_LIVE_SOURCE_SCHEMA_VERSION ||
    !own(value.snapshot.scope, [
      'projectId',
      'taskId',
      'surfaceId',
      'sessionId',
      'channelId',
    ]) ||
    !id(value.snapshot.scope.projectId) ||
    !id(value.snapshot.scope.taskId) ||
    !id(value.snapshot.scope.surfaceId) ||
    !id(value.snapshot.scope.sessionId) ||
    generation !== value.snapshot.scope.sessionId ||
    !id(value.snapshot.scope.channelId) ||
    !['active', 'stale', 'degraded'].includes(String(value.snapshot.state)) ||
    !Array.isArray(value.snapshot.participants) ||
    value.snapshot.participants.length > 256 ||
    !Array.isArray(value.snapshot.panes) ||
    value.snapshot.panes.length > 512 ||
    !Array.isArray(value.snapshot.cursors) ||
    value.snapshot.cursors.length > 64 ||
    !Array.isArray(value.snapshot.typing) ||
    value.snapshot.typing.length > 256 ||
    !value.snapshot.typing.every(validLiveTyping)
  )
    return undefined;
  const participants = value.snapshot.participants.map(liveParticipant);
  const panes = value.snapshot.panes.map(livePane);
  const cursors = value.snapshot.cursors.map(liveCursor);
  if (
    participants.some((participant) => !participant) ||
    panes.some((pane) => !pane) ||
    cursors.some((cursor) => !cursor)
  )
    return undefined;
  return {
    generation,
    viewerActorId,
    scope: {
      projectId: value.snapshot.scope.projectId,
      taskId: value.snapshot.scope.taskId,
    },
    state: value.snapshot.state as 'active' | 'stale' | 'degraded',
    participants: participants as ProjectTaskRoomBrowserLiveParticipant[],
    panes: panes as ProjectTaskRoomBrowserLivePane[],
    cursors: cursors as ProjectTaskRoomBrowserLiveCursor[],
    ...(result ? { result } : {}),
  };
}

function closedLiveSnapshot(
  value: unknown,
): ProjectTaskRoomBrowserLiveSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as RecordValue;
  if (
    !own(row, [
      'generation',
      'viewerActorId',
      'scope',
      'state',
      'participants',
      'panes',
      'cursors',
      ...(hasOwn(row, 'result') ? ['result'] : []),
    ]) ||
    !id(row.generation) ||
    !id(row.viewerActorId) ||
    !own(row.scope, ['projectId', 'taskId']) ||
    !id(row.scope.projectId) ||
    !id(row.scope.taskId) ||
    !['active', 'stale', 'degraded'].includes(String(row.state)) ||
    !Array.isArray(row.participants) ||
    row.participants.length > 256 ||
    !Array.isArray(row.panes) ||
    row.panes.length > 512 ||
    !Array.isArray(row.cursors) ||
    row.cursors.length > 64
  )
    return undefined;
  const participants = row.participants.map(liveParticipant);
  const panes = row.panes.map(livePane);
  const cursors = row.cursors.map(liveCursor);
  const result = hasOwn(row, 'result')
    ? liveMutationResult(row.result)
    : undefined;
  if (
    participants.some((participant) => !participant) ||
    panes.some((pane) => !pane) ||
    cursors.some((cursor) => !cursor) ||
    (hasOwn(row, 'result') && !result)
  )
    return undefined;
  return {
    generation: row.generation,
    viewerActorId: row.viewerActorId,
    scope: { projectId: row.scope.projectId, taskId: row.scope.taskId },
    state: row.state as 'active' | 'stale' | 'degraded',
    participants: participants as ProjectTaskRoomBrowserLiveParticipant[],
    panes: panes as ProjectTaskRoomBrowserLivePane[],
    cursors: cursors as ProjectTaskRoomBrowserLiveCursor[],
    ...(result ? { result } : {}),
  };
}

function liveMutationResult(
  value: unknown,
  allowRuntimeReceipt = false,
): ProjectTaskRoomBrowserLiveMutationResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as RecordValue;
  const outcome = hasOwn(row, 'outcome') ? row.outcome : undefined;
  if (
    [
      'joined',
      'refreshed',
      'updated',
      'cleared',
      'departed',
      'paused',
    ].includes(String(outcome)) &&
    own(
      row,
      allowRuntimeReceipt && hasOwn(row, 'receipt')
        ? ['outcome', 'receipt']
        : ['outcome'],
    )
  )
    return {
      outcome: outcome as
        | 'joined'
        | 'refreshed'
        | 'updated'
        | 'cleared'
        | 'departed'
        | 'paused',
    };
  if (
    outcome === 'degraded' &&
    own(row, ['outcome', 'intentId', 'state']) &&
    id(row.intentId) &&
    (row.state === 'indeterminate' || row.state === 'refused')
  )
    return { outcome: 'degraded', intentId: row.intentId, state: row.state };
  if (
    [
      'invalid',
      'forbidden',
      'unavailable',
      'identity_changed',
      'capacity_exceeded',
      'rate_limited',
    ].includes(String(outcome)) &&
    own(row, ['outcome'])
  )
    return {
      outcome: outcome as
        | 'invalid'
        | 'forbidden'
        | 'unavailable'
        | 'identity_changed'
        | 'capacity_exceeded'
        | 'rate_limited',
    };
  return undefined;
}

/** Accepts only the two server-authored SSE live envelopes. */
export function parseProjectTaskRoomBrowserLiveSnapshot(
  value: unknown,
): ProjectTaskRoomBrowserLiveSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as RecordValue;
  const type = hasOwn(row, 'type') ? row.type : undefined;
  if (
    type === 'snapshot' &&
    own(row, ['type', 'generation', 'viewerActorId', 'live', 'document'])
  )
    return (
      closedLiveSnapshot(row.live) ??
      liveSnapshot(row.generation, row.viewerActorId, row.live)
    );
  if (
    type === 'live' &&
    own(row, [
      'type',
      'kind',
      'generation',
      'viewerActorId',
      'result',
      'snapshot',
    ])
  ) {
    if (row.kind !== 'available') return undefined;
    const closed = closedLiveSnapshot(row.snapshot);
    const result = liveMutationResult(row.result, !closed);
    if (!result) return undefined;
    if (closed)
      return closed.generation === row.generation &&
        JSON.stringify(closed.result) === JSON.stringify(result)
        ? closed
        : undefined;
    return liveSnapshot(
      row.generation,
      row.viewerActorId,
      row.snapshot,
      result,
    );
  }
  return undefined;
}
export function parseProjectTaskRoomBrowserDiscovery(
  value: unknown,
): ProjectTaskRoomBrowserDiscovery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as RecordValue;
  const kind = hasOwn(row, 'kind') ? row.kind : undefined;
  if (
    ['not-found', 'denied', 'unavailable'].includes(String(kind)) &&
    own(row, ['kind'])
  )
    return { kind: kind as 'not-found' | 'denied' | 'unavailable' };
  if (
    !['opened', 'existing'].includes(String(kind)) ||
    !own(row, ['kind', 'scope', 'channelId', 'assurance', 'capabilities']) ||
    !own(row.scope, ['projectId', 'taskId']) ||
    !id(row.scope.projectId) ||
    !id(row.scope.taskId) ||
    !id(row.channelId) ||
    row.assurance !== 'L0' ||
    !own(row.capabilities, [
      'historyRead',
      'messageWrite',
      'live',
      'documentRead',
      'documentWrite',
      'revisionLinks',
    ])
  )
    return undefined;
  const caps = row.capabilities;
  if (!Object.values(caps).every((item) => typeof item === 'boolean'))
    return undefined;
  return {
    kind: kind as 'opened' | 'existing',
    scope: { projectId: row.scope.projectId, taskId: row.scope.taskId },
    channelId: row.channelId,
    assurance: 'L0',
    capabilities: {
      historyRead: caps.historyRead as boolean,
      messageWrite: caps.messageWrite as boolean,
      live: caps.live as boolean,
      documentRead: caps.documentRead as boolean,
      documentWrite: caps.documentWrite as boolean,
      revisionLinks: caps.revisionLinks as boolean,
    },
  };
}
export function parseProjectTaskRoomBrowserHistory(
  value: unknown,
): ProjectTaskRoomBrowserHistory | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = value as RecordValue;
  const kind = hasOwn(row, 'kind') ? row.kind : undefined;
  if (
    ['invalid-cursor', 'not-found', 'denied', 'unavailable'].includes(
      String(kind),
    ) &&
    own(row, ['kind'])
  )
    return {
      kind: kind as ProjectTaskRoomBrowserHistory['kind'] &
        ('invalid-cursor' | 'not-found' | 'denied' | 'unavailable'),
    };
  if (
    kind === 'available' &&
    own(row, [
      'kind',
      'records',
      'checkpoint',
      'hasMore',
      ...(hasOwn(row, 'nextCursor') ? ['nextCursor'] : []),
      'integrity',
    ]) &&
    Array.isArray(row.records) &&
    row.records.length <= 100 &&
    typeof row.hasMore === 'boolean' &&
    row.integrity === 'L0'
  ) {
    const rows = row.records.map(record);
    const mark = checkpoint(row.checkpoint);
    if (
      !mark ||
      rows.some((item) => !item) ||
      (hasOwn(row, 'nextCursor') && !cursor(row.nextCursor)) ||
      row.hasMore !== hasOwn(row, 'nextCursor') ||
      rows.some(
        (item, index) =>
          !!item &&
          (item.sequence > mark.throughSeq ||
            item.sequence <= mark.retainedAnchorSeq ||
            (index > 0 && item.sequence <= rows[index - 1]!.sequence)),
      )
    )
      return undefined;
    return {
      kind: 'available',
      records: rows as ProjectTaskRoomBrowserRecord[],
      checkpoint: mark,
      hasMore: row.hasMore,
      ...(typeof row.nextCursor === 'string'
        ? { nextCursor: row.nextCursor }
        : {}),
      integrity: 'L0',
    };
  }
  if (
    kind === 'gap' &&
    own(row, ['kind', 'missingThroughSeq', 'checkpoint', 'resumeCursor']) &&
    integer(row.missingThroughSeq) &&
    cursor(row.resumeCursor)
  ) {
    const mark = checkpoint(row.checkpoint);
    return mark
      ? {
          kind: 'gap',
          missingThroughSeq: row.missingThroughSeq,
          checkpoint: mark,
          resumeCursor: row.resumeCursor,
        }
      : undefined;
  }
  if (
    kind === 'stale' &&
    own(row, hasOwn(row, 'checkpoint') ? ['kind', 'checkpoint'] : ['kind'])
  ) {
    const mark = hasOwn(row, 'checkpoint')
      ? checkpoint(row.checkpoint)
      : undefined;
    return !hasOwn(row, 'checkpoint') || mark
      ? { kind: 'stale', ...(mark ? { checkpoint: mark } : {}) }
      : undefined;
  }
  return undefined;
}
