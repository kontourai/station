import {
  DELEGATION_GROUP_LIMITS,
  type DelegationGroupCancelResult,
  type DelegationGroupCommandInput,
  type DelegationGroupCreateInput,
  type DelegationGroupEventPage,
  type DelegationGroupListPage,
  type DelegationGroupMemberEventPage,
  type DelegationGroupOperationResult,
  type DelegationGroupRawOutputResult,
  type DelegationGroupView,
} from '@kontourai/station-contracts/delegation-group';
import { readInputRequestForm } from '@kontourai/station-shared/input-request';
import {
  type ClientRequestOptions,
  type FetchSseConnection,
  fetchSSE,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
  StationHttpError,
  StationRequestAuthorityError,
  StationSseProtocolError,
} from './http';

export interface DelegationGroupStreamCallbacks<T> {
  onPage(page: T): void;
  onError?(error: unknown): void;
  onOpen?(): void;
  onTerminal?(error: unknown): void;
}

class DelegationGroupProtocolError extends Error {}

function terminalStreamFailure(error: unknown): boolean {
  return (
    error instanceof DelegationGroupProtocolError ||
    error instanceof StationSseProtocolError ||
    error instanceof StationRequestAuthorityError ||
    (error instanceof StationHttpError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429)
  );
}

function subscribePages<T>(
  url: string,
  event: string,
  prefix: string,
  initialCursor: number,
  validate: (value: unknown) => value is T,
  next: (page: T) => number,
  repeated: (page: T, cursor: number) => boolean,
  callbacks: DelegationGroupStreamCallbacks<T>,
  options?: ClientRequestOptions,
): FetchSseConnection {
  let cursor = initialCursor;
  return fetchSSE(url, {
    ...options,
    maxFrameBytes: DELEGATION_GROUP_LIMITS.responseBytes,
    stopOnError: terminalStreamFailure,
    onOpen: callbacks.onOpen,
    onError: callbacks.onError,
    onTerminal: callbacks.onTerminal,
    validateCheckpoint(checkpoint) {
      // An id-only frame cannot attest that the intervening private page was delivered.
      if (checkpoint.id !== undefined && checkpoint.id !== `${prefix}${cursor}`)
        throw new DelegationGroupProtocolError(
          'Invalid delegation group stream checkpoint cursor.',
        );
    },
    onMessage(message) {
      if (message.event === 'unavailable')
        throw new DelegationGroupProtocolError(
          'Delegation group stream unavailable.',
        );
      if (message.event !== event) return false;
      let page: unknown;
      try {
        page = JSON.parse(message.data);
      } catch {
        throw new DelegationGroupProtocolError(
          'Invalid delegation group event page JSON.',
        );
      }
      if (
        !validate(page) ||
        next(page) < cursor ||
        message.id !== `${prefix}${next(page)}`
      )
        throw new DelegationGroupProtocolError(
          'Invalid delegation group event page.',
        );
      if (repeated(page, cursor)) return false;
      callbacks.onPage(page);
      cursor = next(page);
      return true;
    },
  });
}

export function subscribeDelegationGroupEvents(
  apiBase: string,
  groupId: string,
  afterRevision: number,
  callbacks: DelegationGroupStreamCallbacks<DelegationGroupEventPage>,
  options?: ClientRequestOptions,
): FetchSseConnection {
  let cursor = afterRevision;
  return subscribePages(
    `${groupPath(apiBase, groupId)}/events/stream?afterRevision=${afterRevision}`,
    'group-events',
    `group:${encodeURIComponent(groupId)}:`,
    afterRevision,
    (value): value is DelegationGroupEventPage =>
      isGroupPage(value, groupId) &&
      value.afterRevision <= cursor &&
      (value.nextRevision === cursor || value.afterRevision === cursor),
    (page) => page.nextRevision,
    (page, delivered) =>
      page.events.length > 0 &&
      page.events.every((event) => event.revision <= delivered),
    {
      ...callbacks,
      onPage(page) {
        callbacks.onPage(page);
        cursor = page.nextRevision;
      },
    },
    options,
  );
}

export function subscribeDelegationGroupMemberEvents(
  apiBase: string,
  groupId: string,
  seatId: string,
  afterSequence: number,
  callbacks: DelegationGroupStreamCallbacks<DelegationGroupMemberEventPage>,
  options?: ClientRequestOptions,
): FetchSseConnection {
  const seen = new Map<string, number>();
  let cursor = afterSequence;
  return subscribePages(
    `${memberPath(apiBase, groupId, seatId)}/events/stream?afterSequence=${afterSequence}`,
    'member-events',
    `member:${encodeURIComponent(groupId)}:${encodeURIComponent(seatId)}:`,
    afterSequence,
    (value): value is DelegationGroupMemberEventPage =>
      isMemberPage(value, groupId, seatId) &&
      (value.nextSequence === cursor ||
        value.events.every((event) => event.sequence > cursor)) &&
      value.events.every(
        (event) =>
          !seen.has(event.eventId) ||
          seen.get(event.eventId) === event.sequence,
      ),
    (page) => page.nextSequence,
    (page, delivered) =>
      page.events.length > 0 &&
      page.events.every((event) => event.sequence <= delivered),
    {
      ...callbacks,
      onPage(page) {
        callbacks.onPage(page);
        cursor = page.nextSequence;
        if (page.events.length > 0) seen.clear();
        for (const event of page.events)
          seen.set(event.eventId, event.sequence);
      },
    },
    options,
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
const oneOf = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && allowed.includes(value);
const nullableText = (value: unknown) => value === null || text(value);
function reference(value: unknown): boolean {
  return (
    record(value) && text(value.id) && text(value.domain) && text(value.digest)
  );
}
function isGroup(
  value: unknown,
  groupId?: string,
): value is DelegationGroupView {
  if (
    !record(value) ||
    value.version !== 'station.delegation-group/v1' ||
    !text(value.groupId) ||
    (groupId !== undefined && value.groupId !== groupId) ||
    !integer(value.revision) ||
    !oneOf(value.execution, ['idle', 'execution_unknown', 'returned']) ||
    !oneOf(value.cancellation, ['none', 'pending', 'requested']) ||
    !oneOf(value.terminal, ['unproven', 'proven']) ||
    value.acceptance !== 'unassessed' ||
    !record(value.executionCapability) ||
    value.executionCapability.status !== 'unavailable' ||
    value.executionCapability.code !== 'physical_adapter_unqualified' ||
    !record(value.topology) ||
    !(
      value.topology.kind === 'independent-advisory' ||
      (value.topology.kind === 'flow' &&
        text(value.topology.runId) &&
        record(value.topology.definition) &&
        text(value.topology.definition.id) &&
        text(value.topology.definition.version) &&
        text(value.topology.definition.digest))
    ) ||
    !Array.isArray(value.members)
  )
    return false;
  const seats = new Set<string>();
  return value.members.every((member) => {
    if (
      !record(member) ||
      !text(member.seatId) ||
      seats.has(member.seatId) ||
      !text(member.taskId) ||
      !text(member.conversationId) ||
      !text(member.sessionId) ||
      !text(member.clientTurnId) ||
      !nullableText(member.claimId) ||
      !nullableText(member.invocationId) ||
      !nullableText(member.providerTurnId) ||
      !nullableText(member.outcome) ||
      !oneOf(member.bindingState, [
        'reserved',
        'launch-intent',
        'session-started',
        'turn-accepted',
        'observed',
      ]) ||
      !(member.outputRef === null || reference(member.outputRef)) ||
      !Array.isArray(member.dissentRefs) ||
      !member.dissentRefs.every(reference) ||
      !Array.isArray(member.uncertaintyRefs) ||
      !member.uncertaintyRefs.every(reference) ||
      !oneOf(member.terminalProof, ['unproven', 'proven'])
    )
      return false;
    seats.add(member.seatId);
    return true;
  });
}
function unavailable(value: unknown, min: number, max: number): boolean {
  if (!Array.isArray(value)) return false;
  let previous = -1;
  return value.every((item) => {
    if (
      !record(item) ||
      !integer(item.cursor) ||
      item.cursor < min ||
      item.cursor > max ||
      item.cursor <= previous ||
      item.code !== 'item_too_large'
    )
      return false;
    previous = item.cursor;
    return true;
  });
}
function isGroupPage(
  value: unknown,
  groupId: string,
  afterRevision?: number,
): value is DelegationGroupEventPage {
  if (
    !record(value) ||
    value.groupId !== groupId ||
    !integer(value.afterRevision) ||
    !integer(value.nextRevision) ||
    value.nextRevision < value.afterRevision ||
    (afterRevision !== undefined && value.afterRevision !== afterRevision) ||
    typeof value.hasMore !== 'boolean' ||
    !unavailable(value.unavailable, value.afterRevision, value.nextRevision) ||
    !Array.isArray(value.events) ||
    value.events.length > DELEGATION_GROUP_LIMITS.pageSize
  )
    return false;
  let revision = value.afterRevision;
  const nextRevision = value.nextRevision;
  return value.events.every((event) => {
    if (
      !record(event) ||
      !integer(event.revision) ||
      event.revision <= revision ||
      event.revision > nextRevision ||
      !text(event.kind) ||
      (event.seatId !== undefined && !text(event.seatId)) ||
      (event.invocationId !== undefined && !text(event.invocationId)) ||
      (event.outputRef !== undefined && !reference(event.outputRef))
    )
      return false;
    revision = event.revision;
    return true;
  });
}
function isMemberPage(
  value: unknown,
  groupId: string,
  seatId: string,
  afterSequence = 0,
): value is DelegationGroupMemberEventPage {
  if (
    !record(value) ||
    value.groupId !== groupId ||
    value.seatId !== seatId ||
    !integer(value.nextSequence) ||
    value.nextSequence < afterSequence ||
    !oneOf(value.state, ['available', 'unavailable']) ||
    typeof value.hasMore !== 'boolean' ||
    !unavailable(value.unavailable, afterSequence, value.nextSequence) ||
    !Array.isArray(value.events) ||
    value.events.length > DELEGATION_GROUP_LIMITS.memberPageSize
  )
    return false;
  let sequence = afterSequence;
  const nextSequence = value.nextSequence;
  const ids = new Set<string>();
  return value.events.every((event) => {
    if (
      !record(event) ||
      !text(event.eventId) ||
      ids.has(event.eventId) ||
      !integer(event.sequence) ||
      event.sequence <= sequence ||
      event.sequence > nextSequence ||
      !text(event.kind) ||
      (event.turnId !== undefined && !text(event.turnId)) ||
      (event.inputRequest !== undefined &&
        (!record(event.inputRequest) ||
          !text(event.inputRequest.requestId) ||
          !text(event.inputRequest.requestEventId) ||
          readInputRequestForm(event.inputRequest.form) === null))
    )
      return false;
    ids.add(event.eventId);
    sequence = event.sequence;
    return true;
  });
}
function isList(value: unknown): value is DelegationGroupListPage {
  if (
    !record(value) ||
    !Array.isArray(value.groups) ||
    value.groups.length > DELEGATION_GROUP_LIMITS.pageSize ||
    !value.groups.every((group) => isGroup(group)) ||
    !(value.nextGroupId === null || text(value.nextGroupId)) ||
    typeof value.hasMore !== 'boolean' ||
    (value.hasMore && value.nextGroupId === null) ||
    !Array.isArray(value.unavailable)
  )
    return false;
  const ids = value.groups.map((group) => group.groupId);
  return (
    new Set(ids).size === ids.length &&
    value.unavailable.every(
      (item) =>
        record(item) && text(item.cursor) && item.code === 'item_too_large',
    )
  );
}
function isOperation(
  value: unknown,
  groupId?: string,
): value is DelegationGroupOperationResult {
  return (
    record(value) &&
    typeof value.replayed === 'boolean' &&
    isGroup(value.group, groupId)
  );
}
function isCancel(
  value: unknown,
  groupId: string,
): value is DelegationGroupCancelResult {
  return (
    record(value) &&
    (value.disposition === 'requested' || value.disposition === 'pending') &&
    isGroup(value.group, groupId)
  );
}
function json(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value)
      ? value.every(json)
      : record(value) && Object.values(value).every(json))
  );
}
function isOutput(value: unknown): value is DelegationGroupRawOutputResult {
  return (
    record(value) &&
    reference(value.reference) &&
    json(value.raw) &&
    json(value.rawResult)
  );
}

const root = (apiBase: string) => `${apiBase}/api/orchestration/groups`;
const groupPath = (apiBase: string, groupId: string) =>
  `${root(apiBase)}/${encodeURIComponent(groupId)}`;
const memberPath = (apiBase: string, groupId: string, seatId: string) =>
  `${groupPath(apiBase, groupId)}/members/${encodeURIComponent(seatId)}`;

async function read<T>(
  url: string,
  validate: (value: unknown) => value is T,
  options?: ClientRequestOptions,
): Promise<T> {
  const response = await getJson(url, {
    ...options,
    maxResponseBytes: DELEGATION_GROUP_LIMITS.responseBytes,
  });
  const data = await readEnvelopeOrThrow<unknown>(response);
  if (!validate(data))
    throw new DelegationGroupProtocolError(
      'Invalid delegation group response.',
    );
  return data;
}

async function command<T>(
  url: string,
  input: unknown,
  validate: (value: unknown) => value is T,
  options?: ClientRequestOptions,
): Promise<T> {
  const body = JSON.stringify(input);
  if (
    new TextEncoder().encode(body).length > DELEGATION_GROUP_LIMITS.requestBytes
  )
    throw new Error('Delegation group request exceeds its byte limit.');
  const response = await mutateJson(
    url,
    'POST',
    { ...options, maxResponseBytes: DELEGATION_GROUP_LIMITS.responseBytes },
    input,
  );
  const data = await readEnvelopeOrThrow<unknown>(response);
  if (!validate(data))
    throw new DelegationGroupProtocolError(
      'Invalid delegation group response.',
    );
  return data;
}

export function createDelegationGroup(
  apiBase: string,
  input: DelegationGroupCreateInput,
  options?: ClientRequestOptions,
): Promise<DelegationGroupOperationResult> {
  return command(
    root(apiBase),
    { preparationId: input.preparationId, operationId: input.operationId },
    isOperation,
    options,
  );
}

export function getDelegationGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<DelegationGroupView> {
  return read(
    groupPath(apiBase, groupId),
    (value): value is DelegationGroupView => isGroup(value, groupId),
    options,
  );
}

export function listDelegationGroups(
  apiBase: string,
  input?: { afterGroupId?: string },
  options?: ClientRequestOptions,
): Promise<DelegationGroupListPage> {
  const query =
    input?.afterGroupId === undefined
      ? ''
      : `?${new URLSearchParams({ afterGroupId: input.afterGroupId })}`;
  return read(`${root(apiBase)}${query}`, isList, options);
}

export function readDelegationGroupEvents(
  apiBase: string,
  groupId: string,
  input?: { afterRevision?: number },
  options?: ClientRequestOptions,
): Promise<DelegationGroupEventPage> {
  const query =
    input?.afterRevision === undefined
      ? ''
      : `?${new URLSearchParams({ afterRevision: String(input.afterRevision) })}`;
  return read(
    `${groupPath(apiBase, groupId)}/events${query}`,
    (value): value is DelegationGroupEventPage =>
      isGroupPage(value, groupId, input?.afterRevision ?? 0),
    options,
  );
}

export function cancelDelegationGroup(
  apiBase: string,
  groupId: string,
  input: DelegationGroupCommandInput,
  options?: ClientRequestOptions,
): Promise<DelegationGroupCancelResult> {
  return command(
    `${groupPath(apiBase, groupId)}/cancel`,
    {
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
    },
    (value): value is DelegationGroupCancelResult => isCancel(value, groupId),
    options,
  );
}

export function launchDelegationGroup(
  apiBase: string,
  groupId: string,
  input: DelegationGroupCommandInput,
  options?: ClientRequestOptions,
): Promise<DelegationGroupOperationResult> {
  return command(
    `${groupPath(apiBase, groupId)}/run`,
    {
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
    },
    (value): value is DelegationGroupOperationResult =>
      isOperation(value, groupId),
    options,
  );
}

export function readDelegationGroupMemberEvents(
  apiBase: string,
  groupId: string,
  seatId: string,
  input?: { afterSequence?: number },
  options?: ClientRequestOptions,
): Promise<DelegationGroupMemberEventPage> {
  const query =
    input?.afterSequence === undefined
      ? ''
      : `?${new URLSearchParams({ afterSequence: String(input.afterSequence) })}`;
  return read(
    `${memberPath(apiBase, groupId, seatId)}/events${query}`,
    (value): value is DelegationGroupMemberEventPage =>
      isMemberPage(value, groupId, seatId, input?.afterSequence ?? 0),
    options,
  );
}

export function readDelegationGroupMemberOutput(
  apiBase: string,
  groupId: string,
  seatId: string,
  options?: ClientRequestOptions,
): Promise<DelegationGroupRawOutputResult> {
  return read(
    `${memberPath(apiBase, groupId, seatId)}/output`,
    isOutput,
    options,
  );
}
