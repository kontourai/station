/** Durable execution-status envelope around an existing Station mutation. */
export const ACTION_OPERATION_SCHEMA_VERSION =
  'station.action-operation/v1' as const;
export const ACTION_OPERATION_MAX_PAGE_SIZE = 50;
export const ACTION_OPERATION_MAX_ACTIVE = 25;
export const ACTION_OPERATION_MAX_RETAINED_TERMINALS = 25;
export const ACTION_OPERATION_MAX_STORE_BYTES = 512 * 1024;

export const ACTION_OPERATION_PHASE_CODES = [
  'preparing',
  'creating-continuation',
  'cancellation-requested',
  'reconciliation-required',
] as const;
export type ActionOperationPhaseCode =
  (typeof ACTION_OPERATION_PHASE_CODES)[number];

export type ActionOperationStatus =
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ActionOperationProgress =
  | { readonly kind: 'indeterminate' }
  | { readonly kind: 'phase'; readonly code: ActionOperationPhaseCode }
  | {
      readonly kind: 'determinate';
      readonly completed: number;
      readonly total: number;
      readonly unit: 'items' | 'bytes' | 'steps';
    };

export interface ActionOperationScope {
  readonly accountId: string;
  readonly machineId?: string;
  readonly sessionId?: string;
}

export type ActionOperationDomainRef =
  | {
      readonly kind: 'conversation-fork';
      readonly sourceConversationId: string;
      readonly targetConversationId: string;
    }
  | {
      readonly kind: 'session-handoff';
      readonly sourceSessionId: string;
      readonly targetSessionId?: string;
    }
  | {
      /**
       * An active fleet operation has the exact Station session plus its
       * server-minted correlation; terminal settlement adds the sealed
       * receipt id. This refuses both an unscoped pending row and a terminal
       * claim whose routing receipt cannot be inspected.
       */
      readonly kind: 'fleet-dispatch';
      readonly sessionId: string;
      readonly correlationId: string;
      readonly routingReceiptId?: string;
    }
  | { readonly kind: 'platform-action'; readonly actionId: string };

/** Closed Station navigation targets; persisted state never carries a URL/query. */
export type ActionOperationReentry =
  | {
      readonly kind: 'conversation';
      readonly agentId: string;
      readonly conversationId: string;
    }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'monitoring'; readonly routingReceiptId: string };

export interface ActionOperation {
  readonly schemaVersion: typeof ACTION_OPERATION_SCHEMA_VERSION;
  /** Immutable creation order, used only for older-page pagination. */
  readonly id: string;
  readonly sequence: number;
  /** Advances on every create/update and is the reconnect watch coordinate. */
  readonly changeSequence: number;
  readonly revision: number;
  readonly scope: ActionOperationScope;
  readonly status: ActionOperationStatus;
  readonly title: string;
  readonly progress: ActionOperationProgress;
  readonly cancellation: 'supported' | 'unsupported';
  readonly domain: ActionOperationDomainRef;
  readonly reentry: ActionOperationReentry;
  /** A UI-safe terminal summary, never an error body, prompt, secret, or path. */
  readonly errorSummary?: string;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface ActionOperationPage {
  readonly schemaVersion: typeof ACTION_OPERATION_SCHEMA_VERSION;
  readonly items: readonly ActionOperation[];
  readonly nextCursor?: string;
}

export interface ActionOperationWatchSnapshot extends ActionOperationPage {
  /** Latest visible change sequence included; never a global ledger head. */
  readonly cursor: string;
  readonly mode: 'snapshot' | 'delta';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
function own(value: Record<string, unknown>, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}
function exactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((field, index) => field === sorted[index])
  );
}
function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/**
 * Action operations are rendered to every account-scoped Activity reader, so
 * free text is a deliberately tiny public-copy channel. It accepts a normal
 * phrase, not diagnostics: absolute POSIX/Windows/UNC paths and URLs are all
 * rejected rather than trying to redact a machine-local fragment out of an
 * otherwise plausible sentence.
 */
function containsMachineLocalPath(value: string): boolean {
  return (
    /(?:^|[^\p{L}\p{N}])\/(?=\S)/u.test(value) ||
    /(?:^|[^\p{L}\p{N}])[A-Za-z]:[\\/]/u.test(value) ||
    /\\/.test(value) ||
    /(?:^|[\s"'(=,:])~[\\/]/u.test(value)
  );
}

function publicText(value: unknown, max = 320): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    }) &&
    !containsMachineLocalPath(value) &&
    !/(?:token|secret|authorization|bearer|api[_-]?key)\s*[:=]/i.test(value) &&
    !/[?&][A-Za-z0-9_.-]+=/.test(value)
  );
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function parseScope(value: unknown): ActionOperationScope | undefined {
  if (!record(value)) return undefined;
  const expected = [
    'accountId',
    ...(own(value, 'machineId') ? ['machineId'] : []),
    ...(own(value, 'sessionId') ? ['sessionId'] : []),
  ];
  if (
    !exactFields(value, expected) ||
    !id(value.accountId) ||
    (own(value, 'machineId') && !id(value.machineId)) ||
    (own(value, 'sessionId') && !id(value.sessionId))
  ) {
    return undefined;
  }
  return {
    accountId: value.accountId,
    ...(typeof value.machineId === 'string'
      ? { machineId: value.machineId }
      : {}),
    ...(typeof value.sessionId === 'string'
      ? { sessionId: value.sessionId }
      : {}),
  };
}

function parseProgress(value: unknown): ActionOperationProgress | undefined {
  if (!record(value) || typeof value.kind !== 'string') return undefined;
  if (value.kind === 'indeterminate' && exactFields(value, ['kind'])) {
    return { kind: 'indeterminate' };
  }
  if (
    value.kind === 'phase' &&
    exactFields(value, ['kind', 'code']) &&
    ACTION_OPERATION_PHASE_CODES.includes(
      value.code as ActionOperationPhaseCode,
    )
  ) {
    return { kind: 'phase', code: value.code as ActionOperationPhaseCode };
  }
  if (
    value.kind === 'determinate' &&
    exactFields(value, ['kind', 'completed', 'total', 'unit']) &&
    Number.isSafeInteger(value.completed) &&
    Number.isSafeInteger(value.total) &&
    (value.completed as number) >= 0 &&
    (value.total as number) > 0 &&
    (value.completed as number) <= (value.total as number) &&
    ['items', 'bytes', 'steps'].includes(String(value.unit))
  ) {
    return {
      kind: 'determinate',
      completed: value.completed as number,
      total: value.total as number,
      unit: value.unit as 'items' | 'bytes' | 'steps',
    };
  }
  return undefined;
}

function parseDomain(
  value: unknown,
  terminal: boolean,
): ActionOperationDomainRef | undefined {
  if (!record(value) || typeof value.kind !== 'string') return undefined;
  if (
    value.kind === 'conversation-fork' &&
    exactFields(value, [
      'kind',
      'sourceConversationId',
      'targetConversationId',
    ]) &&
    id(value.sourceConversationId) &&
    id(value.targetConversationId)
  ) {
    return {
      kind: 'conversation-fork',
      sourceConversationId: value.sourceConversationId,
      targetConversationId: value.targetConversationId,
    };
  }
  if (value.kind === 'session-handoff') {
    const expected = [
      'kind',
      'sourceSessionId',
      ...(own(value, 'targetSessionId') ? ['targetSessionId'] : []),
    ];
    if (
      exactFields(value, expected) &&
      id(value.sourceSessionId) &&
      (!own(value, 'targetSessionId') || id(value.targetSessionId))
    ) {
      return {
        kind: 'session-handoff',
        sourceSessionId: value.sourceSessionId,
        ...(typeof value.targetSessionId === 'string'
          ? { targetSessionId: value.targetSessionId }
          : {}),
      };
    }
  }
  if (value.kind === 'fleet-dispatch') {
    const expected = [
      'kind',
      'sessionId',
      'correlationId',
      ...(own(value, 'routingReceiptId') ? ['routingReceiptId'] : []),
    ];
    if (
      !exactFields(value, expected) ||
      !id(value.sessionId) ||
      !id(value.correlationId) ||
      terminal !== own(value, 'routingReceiptId') ||
      (own(value, 'routingReceiptId') && !id(value.routingReceiptId))
    ) {
      return undefined;
    }
    return {
      kind: 'fleet-dispatch',
      sessionId: value.sessionId,
      correlationId: value.correlationId,
      ...(typeof value.routingReceiptId === 'string'
        ? { routingReceiptId: value.routingReceiptId }
        : {}),
    };
  }
  if (
    value.kind === 'platform-action' &&
    exactFields(value, ['kind', 'actionId']) &&
    id(value.actionId)
  ) {
    return { kind: 'platform-action', actionId: value.actionId };
  }
  return undefined;
}

function parseReentry(value: unknown): ActionOperationReentry | undefined {
  if (!record(value) || typeof value.kind !== 'string') return undefined;
  if (
    value.kind === 'conversation' &&
    exactFields(value, ['kind', 'agentId', 'conversationId']) &&
    id(value.agentId) &&
    id(value.conversationId)
  ) {
    return {
      kind: 'conversation',
      agentId: value.agentId,
      conversationId: value.conversationId,
    };
  }
  if (
    value.kind === 'session' &&
    exactFields(value, ['kind', 'sessionId']) &&
    id(value.sessionId)
  ) {
    return { kind: 'session', sessionId: value.sessionId };
  }
  if (
    value.kind === 'monitoring' &&
    exactFields(value, ['kind', 'routingReceiptId']) &&
    id(value.routingReceiptId)
  ) {
    return { kind: 'monitoring', routingReceiptId: value.routingReceiptId };
  }
  return undefined;
}

/** Strict transport/storage boundary: unknown and unsafe fields fail closed. */
export function parseActionOperation(
  value: unknown,
): ActionOperation | undefined {
  if (!record(value)) return undefined;
  const expected = [
    'schemaVersion',
    'id',
    'sequence',
    'changeSequence',
    'revision',
    'scope',
    'status',
    'title',
    'progress',
    'cancellation',
    'domain',
    'reentry',
    'acceptedAt',
    'updatedAt',
    ...(own(value, 'errorSummary') ? ['errorSummary'] : []),
    ...(own(value, 'completedAt') ? ['completedAt'] : []),
  ];
  const status = value.status;
  const terminal = isTerminalActionOperation(status as ActionOperationStatus);
  const scope = parseScope(value.scope);
  const progress = parseProgress(value.progress);
  const domain = parseDomain(value.domain, terminal);
  const reentry = parseReentry(value.reentry);
  if (
    !exactFields(value, expected) ||
    value.schemaVersion !== ACTION_OPERATION_SCHEMA_VERSION ||
    !id(value.id) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !Number.isSafeInteger(value.changeSequence) ||
    (value.changeSequence as number) < 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !scope ||
    !['accepted', 'running', 'succeeded', 'failed', 'cancelled'].includes(
      String(status),
    ) ||
    !publicText(value.title, 160) ||
    !progress ||
    (value.cancellation !== 'supported' &&
      value.cancellation !== 'unsupported') ||
    !domain ||
    !reentry ||
    !timestamp(value.acceptedAt) ||
    !timestamp(value.updatedAt) ||
    (own(value, 'completedAt') && !timestamp(value.completedAt)) ||
    (own(value, 'errorSummary') && !publicText(value.errorSummary))
  ) {
    return undefined;
  }
  if (terminal !== own(value, 'completedAt')) return undefined;
  if ((status === 'failed') !== own(value, 'errorSummary')) return undefined;
  return {
    schemaVersion: ACTION_OPERATION_SCHEMA_VERSION,
    id: value.id,
    sequence: value.sequence as number,
    changeSequence: value.changeSequence as number,
    revision: value.revision as number,
    scope,
    status: status as ActionOperationStatus,
    title: value.title,
    progress,
    cancellation: value.cancellation,
    domain,
    reentry,
    ...(typeof value.errorSummary === 'string'
      ? { errorSummary: value.errorSummary }
      : {}),
    acceptedAt: value.acceptedAt,
    updatedAt: value.updatedAt,
    ...(typeof value.completedAt === 'string'
      ? { completedAt: value.completedAt }
      : {}),
  };
}

export function isTerminalActionOperation(
  status: ActionOperationStatus,
): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled'
  );
}
