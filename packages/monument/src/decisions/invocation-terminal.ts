import type { TurnBoundaryAcceptInvocationCommand } from '../commands.js';
import type { OwnerIdentity } from '../owner.js';
import type {
  InvocationTerminalFact,
  InvocationTerminalQuery,
  InvocationTerminalRead,
  InvocationTerminalRetirement,
  PreparedTurnIntent,
  TurnBoundaryRecord,
  TurnDedupRecord,
} from '../records.js';
import { compareCodePoints } from './order.js';
import { isPreparedTurnSettlement } from './prepared-settlement.js';

/** Inert own data only: accessors and inherited identities cannot supply evidence. */
export function terminalDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        (required.includes(key) || optional.includes(key)) &&
        Object.hasOwn(descriptors[key], 'value') &&
        descriptors[key].enumerable === true,
    ) && required.every((key) => Object.hasOwn(value, key))
  );
}
/** Async/generator callbacks cannot join the synchronous transaction protocol. */
export function isSynchronousTerminalBundle(value: unknown): boolean {
  return (
    terminalDataObject(value, [
      'find',
      'readObservation',
      'readRetirement',
      'recordRetirement',
    ]) &&
    ['find', 'readObservation', 'readRetirement', 'recordRetirement'].every(
      (key) =>
        typeof value[key] === 'function' &&
        Object.prototype.toString.call(value[key]) === '[object Function]',
    )
  );
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';
const optionalText = (value: Record<string, unknown>, key: string): boolean =>
  !Object.hasOwn(value, key) || text(value[key]);
function owner(value: unknown): value is OwnerIdentity {
  return (
    terminalDataObject(value, ['id', 'pid', 'identityKind'], ['birth']) &&
    text(value.id) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    (value.identityKind === 'exact'
      ? text(value.birth)
      : value.identityKind === 'unverified' && !Object.hasOwn(value, 'birth'))
  );
}
function intent(value: unknown): value is PreparedTurnIntent {
  return (
    terminalDataObject(
      value,
      ['invocationId', 'inputDigest', 'intentDigest', 'bodyRef'],
      ['dedupKey'],
    ) &&
    ['invocationId', 'inputDigest', 'intentDigest', 'bodyRef'].every((key) =>
      text(value[key]),
    ) &&
    optionalText(value, 'dedupKey')
  );
}
function isTerminalBoundaryRecord(
  value: unknown,
): value is TurnBoundaryRecord {
  return (
    terminalDataObject(
      value,
      [
        'boundaryId',
        'threadId',
        'state',
        'purpose',
        'owner',
        'createdAt',
        'updatedAt',
      ],
      ['providerTurnId', 'createdSequence', 'intent', 'settlement'],
    ) &&
    ['boundaryId', 'threadId', 'createdAt', 'updatedAt'].every((key) =>
      text(value[key]),
    ) &&
    owner(value.owner) &&
    typeof value.state === 'string' &&
    [
      'lifecycle',
      'reserved',
      'prepared',
      'invoking',
      'accepted',
      'indeterminate',
      'settled',
    ].includes(value.state) &&
    (value.purpose === 'turn' || value.purpose === 'task-dispatch') &&
    optionalText(value, 'providerTurnId') &&
    (!Object.hasOwn(value, 'createdSequence') ||
      value.createdSequence === null ||
      (typeof value.createdSequence === 'number' &&
        Number.isSafeInteger(value.createdSequence) &&
        value.createdSequence >= 0)) &&
    (!Object.hasOwn(value, 'intent') || intent(value.intent)) &&
    (!Object.hasOwn(value, 'settlement') ||
      isPreparedTurnSettlement(value.settlement))
  );
}
function isTerminalDedupRecord(
  value: unknown,
): value is TurnDedupRecord {
  return (
    terminalDataObject(
      value,
      ['key', 'value', 'createdAt'],
      [
        'owner',
        'invocation',
        'preparedInvocationId',
        'preparedUpdatedAt',
        'settlement',
        'inputDigest',
      ],
    ) &&
    optionalText(value, 'inputDigest') &&
    text(value.key) &&
    (value.value === null || typeof value.value === 'string') &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    (!Object.hasOwn(value, 'owner') || owner(value.owner)) &&
    (!Object.hasOwn(value, 'invocation') ||
      (typeof value.invocation === 'string' &&
        ['pending', 'begun', 'untracked'].includes(value.invocation))) &&
    optionalText(value, 'preparedInvocationId') &&
    optionalText(value, 'preparedUpdatedAt') &&
    Object.hasOwn(value, 'preparedInvocationId') ===
      Object.hasOwn(value, 'preparedUpdatedAt') &&
    (!Object.hasOwn(value, 'settlement') ||
      isPreparedTurnSettlement(value.settlement))
  );
}
export function assertInvocationTerminalQuery(
  value: unknown,
): asserts value is InvocationTerminalQuery {
  if (
    !terminalDataObject(
      value,
      ['threadId', 'invocationId', 'allowMissingProviderTurnId'],
      ['providerTurnId', 'terminalEventId'],
    ) ||
    !text(value.threadId) ||
    !text(value.invocationId) ||
    typeof value.allowMissingProviderTurnId !== 'boolean' ||
    !optionalText(value, 'providerTurnId') ||
    !optionalText(value, 'terminalEventId')
  )
    throw new TypeError('Invalid invocation terminal query.');
}
export function assertInvocationTerminalFact(
  value: unknown,
): asserts value is InvocationTerminalFact {
  if (
    !terminalDataObject(
      value,
      [
        'threadId',
        'invocationId',
        'terminalEventId',
        'terminalCreatedAt',
        'retire',
      ],
      ['providerTurnId'],
    ) ||
    !['threadId', 'invocationId', 'terminalEventId', 'terminalCreatedAt'].every(
      (key) => text(value[key]),
    ) ||
    !optionalText(value, 'providerTurnId') ||
    typeof value.retire !== 'boolean'
  )
    throw new TypeError('Invalid invocation terminal fact.');
}
export function sameTerminalData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  )
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameTerminalData(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}
function factMatchesQuery(
  fact: InvocationTerminalFact,
  query: InvocationTerminalQuery,
): boolean {
  return (
    fact.retire &&
    fact.threadId === query.threadId &&
    fact.invocationId === query.invocationId &&
    (query.terminalEventId === undefined ||
      fact.terminalEventId === query.terminalEventId) &&
    (fact.providerTurnId === undefined
      ? query.allowMissingProviderTurnId
      : query.providerTurnId === undefined ||
        fact.providerTurnId === query.providerTurnId)
  );
}
/** Consistency covers the entire retained scope, before any candidate filter. */
export function findInvocationTerminal(
  facts: readonly InvocationTerminalFact[],
  query: InvocationTerminalQuery,
): InvocationTerminalRead {
  assertInvocationTerminalQuery(query);
  const scoped: InvocationTerminalFact[] = [];
  const events = new Map<string, InvocationTerminalFact>();
  for (const fact of facts) {
    assertInvocationTerminalFact(fact);
    if (
      fact.threadId !== query.threadId ||
      fact.invocationId !== query.invocationId
    )
      throw new TypeError('Wrong invocation terminal scope.');
    const previous = events.get(fact.terminalEventId);
    if (previous && !sameTerminalData(previous, fact))
      throw new Error('Conflicting invocation terminal event.');
    events.set(fact.terminalEventId, fact);
    if (fact.retire) scoped.push(fact);
  }
  const native = new Set(
    scoped.flatMap((fact) =>
      fact.providerTurnId === undefined ? [] : [fact.providerTurnId],
    ),
  );
  if (
    native.size > 1 ||
    (query.providerTurnId !== undefined &&
      [...native].some((id) => id !== query.providerTurnId))
  )
    return { kind: 'unknown' };
  const candidates = scoped
    .filter((fact) => factMatchesQuery(fact, query))
    .sort((a, b) => compareCodePoints(a.terminalEventId, b.terminalEventId));
  return candidates[0]
    ? { kind: 'found', fact: candidates[0] }
    : { kind: 'absent' };
}
export function assertInvocationTerminalRead(
  value: unknown,
  query: InvocationTerminalQuery,
): asserts value is InvocationTerminalRead {
  assertInvocationTerminalQuery(query);
  if (!terminalDataObject(value, ['kind'], ['fact']))
    throw new TypeError('Invalid invocation terminal response.');
  if (value.kind === 'absent' || value.kind === 'unknown') {
    if (Object.hasOwn(value, 'fact'))
      throw new TypeError('Invalid invocation terminal response.');
    return;
  }
  if (value.kind !== 'found')
    throw new TypeError('Invalid invocation terminal response.');
  assertInvocationTerminalFact(value.fact);
  if (!factMatchesQuery(value.fact, query))
    throw new TypeError('Invocation terminal response does not match query.');
}
export function invocationTerminalRetires(
  row: TurnBoundaryRecord,
  fact: InvocationTerminalFact,
): boolean {
  return (
    isTerminalBoundaryRecord(row) &&
    row.purpose === 'turn' &&
    row.settlement === undefined &&
    ['invoking', 'indeterminate', 'accepted'].includes(row.state) &&
    row.intent !== undefined &&
    fact.retire &&
    row.threadId === fact.threadId &&
    row.intent.invocationId === fact.invocationId &&
    (row.providerTurnId === undefined ||
      row.providerTurnId === fact.providerTurnId)
  );
}
export function assertInvocationTerminalRetirement(
  value: unknown,
): asserts value is InvocationTerminalRetirement {
  if (
    !terminalDataObject(value, ['schema', 'terminal', 'boundary'], ['dedup']) ||
    value.schema !== 'monument.invocation-terminal-retirement/v1' ||
    !isTerminalBoundaryRecord(value.boundary) ||
    (Object.hasOwn(value, 'dedup') && !isTerminalDedupRecord(value.dedup))
  )
    throw new TypeError('Invalid invocation terminal retirement.');
  assertInvocationTerminalFact(value.terminal);
  if (
    !invocationTerminalRetires(value.boundary, value.terminal) ||
    (value.dedup !== undefined &&
      (!isTerminalDedupRecord(value.dedup) ||
        !value.boundary.intent ||
        value.boundary.intent.dedupKey !== value.dedup.key))
  )
    throw new TypeError('Invalid invocation terminal retirement target.');
}
export function assertAcceptInvocationCommand(
  value: unknown,
): asserts value is TurnBoundaryAcceptInvocationCommand {
  if (
    !terminalDataObject(
      value,
      ['type', 'expected', 'providerTurnId', 'now'],
      ['expectedDedup'],
    ) ||
    value.type !== 'turnBoundary.acceptInvocation' ||
    !isTerminalBoundaryRecord(value.expected) ||
    !text(value.providerTurnId) ||
    !text(value.now) ||
    (Object.hasOwn(value, 'expectedDedup') &&
      !isTerminalDedupRecord(value.expectedDedup))
  )
    throw new TypeError('Invalid invocation acceptance command.');
}
export function acceptanceQuery(
  target: TurnBoundaryRecord,
  command: TurnBoundaryAcceptInvocationCommand,
  witness?: InvocationTerminalRetirement,
): InvocationTerminalQuery | undefined {
  const invocationId = command.expected.intent?.invocationId;
  if (!invocationId) return undefined;
  return {
    threadId: command.expected.threadId,
    invocationId,
    providerTurnId: command.providerTurnId,
    allowMissingProviderTurnId:
      target.providerTurnId === undefined &&
      command.expected.providerTurnId === undefined,
    ...(witness ? { terminalEventId: witness.terminal.terminalEventId } : {}),
  };
}

export function decideTurnBoundaryAcceptInvocation(
  current: TurnBoundaryRecord | undefined,
  threadRows: readonly TurnBoundaryRecord[],
  dedup: TurnDedupRecord | undefined,
  tombstoned: boolean,
  terminal: InvocationTerminalRead,
  witness: InvocationTerminalRetirement | undefined,
  command: TurnBoundaryAcceptInvocationCommand,
): {
  readonly put?: TurnBoundaryRecord;
  readonly remove?: string;
  readonly retirement?: InvocationTerminalRetirement;
  readonly result: import('../commands.js').TurnBoundaryAcceptInvocationResult;
} {
  assertAcceptInvocationCommand(command);
  const expected = command.expected;
  const stale = { result: { kind: 'stale' } } as const;
  if (
    expected.purpose !== 'turn' ||
    !expected.intent ||
    expected.settlement !== undefined ||
    !['invoking', 'indeterminate'].includes(expected.state) ||
    (expected.providerTurnId !== undefined &&
      expected.providerTurnId !== command.providerTurnId)
  )
    return stale;
  const accepted: TurnBoundaryRecord = {
    ...expected,
    state: 'accepted',
    providerTurnId: command.providerTurnId,
    updatedAt: command.now,
  };
  const ambiguous: TurnBoundaryRecord = { ...accepted, state: 'indeterminate' };
  const matches = (row: TurnBoundaryRecord) =>
    sameTerminalData(row, expected) ||
    sameTerminalData(row, accepted) ||
    sameTerminalData(row, ambiguous);
  if (current && (!isTerminalBoundaryRecord(current) || !matches(current)))
    return stale;
  if (witness) {
    assertInvocationTerminalRetirement(witness);
    if (
      witness.boundary.threadId !== expected.threadId ||
      witness.boundary.boundaryId !== expected.boundaryId
    )
      throw new TypeError('Wrong invocation retirement scope.');
  }
  if (!current && (!witness || !matches(witness.boundary))) return stale;
  const original = command.expectedDedup;
  if (expected.intent.dedupKey === undefined) {
    if (original !== undefined || (!current && witness?.dedup !== undefined))
      return stale;
  } else {
    if (
      !original?.owner ||
      original.key !== expected.intent.dedupKey ||
      original.value !== null ||
      original.invocation !== 'begun' ||
      original.settlement !== undefined ||
      original.preparedInvocationId !== expected.intent.invocationId ||
      !text(original.preparedUpdatedAt) ||
      tombstoned
    )
      return stale;
    const resolved = { ...original, value: command.providerTurnId };
    const linkedMatches = (row: TurnDedupRecord | undefined) =>
      row !== undefined &&
      isTerminalDedupRecord(row) &&
      (sameTerminalData(row, original) || sameTerminalData(row, resolved));
    if (!linkedMatches(dedup) || (!current && !linkedMatches(witness?.dedup)))
      return stale;
  }
  const target = current ?? witness?.boundary;
  if (!target) return stale;
  const query = acceptanceQuery(target, command, current ? undefined : witness);
  if (!query) return stale;
  assertInvocationTerminalRead(terminal, query);
  if (terminal.kind === 'unknown') return stale;
  if (terminal.kind === 'found') {
    if (!invocationTerminalRetires(target, terminal.fact)) return stale;
    if (!current)
      return witness && sameTerminalData(witness.terminal, terminal.fact)
        ? { result: { kind: 'terminal', terminal: terminal.fact } }
        : stale;
    return {
      remove: current.boundaryId,
      retirement: {
        schema: 'monument.invocation-terminal-retirement/v1',
        terminal: terminal.fact,
        boundary: current,
        ...(dedup ? { dedup } : {}),
      },
      result: { kind: 'terminal', terminal: terminal.fact },
    };
  }
  if (!current) return stale;
  // E can alias Q. Conservatively acknowledge Q before considering a first attempt.
  if (sameTerminalData(current, ambiguous))
    return { result: { kind: 'ambiguous' } };
  if (sameTerminalData(current, accepted))
    return { result: { kind: 'accepted' } };
  const collision = threadRows.some(
    (row) =>
      row.boundaryId !== current.boundaryId &&
      row.state === 'accepted' &&
      row.providerTurnId === command.providerTurnId,
  );
  return {
    put: collision ? ambiguous : accepted,
    result: { kind: collision ? 'ambiguous' : 'accepted' },
  };
}
