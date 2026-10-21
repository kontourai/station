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
import {
  type ClientRequestOptions,
  type FetchSseConnection,
  fetchSSE,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './http';

export interface DelegationGroupStreamCallbacks<T> {
  onPage(page: T): void;
  onError?(error: unknown): void;
  onOpen?(): void;
}

export function subscribeDelegationGroupEvents(
  apiBase: string,
  groupId: string,
  afterRevision: number,
  callbacks: DelegationGroupStreamCallbacks<DelegationGroupEventPage>,
  options?: ClientRequestOptions,
): FetchSseConnection {
  let cursor = afterRevision;
  return fetchSSE(
    `${groupPath(apiBase, groupId)}/events/stream?afterRevision=${afterRevision}`,
    {
      ...options,
      onOpen: callbacks.onOpen,
      onError: callbacks.onError,
      onMessage(message) {
        if (message.event === 'unavailable')
          throw new Error('Delegation group stream unavailable.');
        if (message.event !== 'group-events') return false;
        if (
          new TextEncoder().encode(message.data).length >
          DELEGATION_GROUP_LIMITS.responseBytes
        )
          throw new Error(
            'Delegation group event page exceeds its byte limit.',
          );
        const page = JSON.parse(message.data) as DelegationGroupEventPage;
        if (
          page.groupId !== groupId ||
          !Number.isSafeInteger(page.nextRevision) ||
          page.nextRevision < cursor ||
          message.id !==
            `group:${encodeURIComponent(groupId)}:${page.nextRevision}` ||
          !Array.isArray(page.events)
        )
          throw new Error('Invalid delegation group event page.');
        callbacks.onPage(page);
        cursor = page.nextRevision;
        return true;
      },
    },
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
  let cursor = afterSequence;
  return fetchSSE(
    `${memberPath(apiBase, groupId, seatId)}/events/stream?afterSequence=${afterSequence}`,
    {
      ...options,
      onOpen: callbacks.onOpen,
      onError: callbacks.onError,
      onMessage(message) {
        if (message.event === 'unavailable')
          throw new Error('Delegation group member stream unavailable.');
        if (message.event !== 'member-events') return false;
        if (
          new TextEncoder().encode(message.data).length >
          DELEGATION_GROUP_LIMITS.responseBytes
        )
          throw new Error(
            'Delegation group member page exceeds its byte limit.',
          );
        const page = JSON.parse(message.data) as DelegationGroupMemberEventPage;
        if (
          page.groupId !== groupId ||
          page.seatId !== seatId ||
          !Number.isSafeInteger(page.nextSequence) ||
          page.nextSequence < cursor ||
          message.id !==
            `member:${encodeURIComponent(groupId)}:${encodeURIComponent(seatId)}:${page.nextSequence}` ||
          !Array.isArray(page.events)
        )
          throw new Error('Invalid delegation group member page.');
        callbacks.onPage(page);
        cursor = page.nextSequence;
        return true;
      },
    },
  );
}

const root = (apiBase: string) => `${apiBase}/api/orchestration/groups`;
const groupPath = (apiBase: string, groupId: string) =>
  `${root(apiBase)}/${encodeURIComponent(groupId)}`;
const memberPath = (apiBase: string, groupId: string, seatId: string) =>
  `${groupPath(apiBase, groupId)}/members/${encodeURIComponent(seatId)}`;

async function read<T>(
  url: string,
  options?: ClientRequestOptions,
): Promise<T> {
  const response = await getJson(url, {
    ...options,
    maxResponseBytes: DELEGATION_GROUP_LIMITS.responseBytes,
  });
  const data = await readEnvelopeOrThrow<T>(response);
  if (data === undefined) throw new Error('Missing delegation group response.');
  return data;
}

async function command<T>(
  url: string,
  input: unknown,
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
  const data = await readEnvelopeOrThrow<T>(response);
  if (data === undefined) throw new Error('Missing delegation group response.');
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
    options,
  );
}

export function getDelegationGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<DelegationGroupView> {
  return read(groupPath(apiBase, groupId), options);
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
  return read(`${root(apiBase)}${query}`, options);
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
  return read(`${groupPath(apiBase, groupId)}/events${query}`, options);
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
    options,
  );
}

export function readDelegationGroupMemberOutput(
  apiBase: string,
  groupId: string,
  seatId: string,
  options?: ClientRequestOptions,
): Promise<DelegationGroupRawOutputResult> {
  return read(`${memberPath(apiBase, groupId, seatId)}/output`, options);
}
