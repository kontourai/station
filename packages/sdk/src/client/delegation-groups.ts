import {
  DELEGATION_GROUP_LIMITS,
  DELEGATION_GROUP_TRANSPORT_VERSION,
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
import { z } from 'zod/v3';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
  StationHttpError,
} from './http';
import { parseReportGroupInput } from './report-groups';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const integer = z.number().int().nonnegative().safe();
const amounts = z
  .object({ inputTokens: integer, outputTokens: integer, costMicros: integer })
  .strict();
const terminal = z.enum(['unproven', 'proven']);
const group = z
  .object({
    version: z.literal(DELEGATION_GROUP_TRANSPORT_VERSION),
    groupId: id,
    revision: integer,
    execution: z.enum(['idle', 'execution_unknown', 'returned']),
    cancellation: z.enum(['none', 'pending', 'requested']),
    terminal,
    acceptance: z.literal('unassessed'),
    topology: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('independent-advisory') }).strict(),
      z.object({ kind: z.literal('flow'), runId: id }).strict(),
    ]),
    members: z
      .array(
        z
          .object({
            seatId: id,
            taskId: id,
            selection: z
              .object({
                agentId: id,
                runtimeProtocol: z.string().min(1).max(128),
                provider: z.string().min(1).max(128),
                modelId: z.string().min(1).max(512),
              })
              .strict(),
            invocationId: id.nullable(),
            outcome: z.string().min(1).max(128).nullable(),
            terminalProof: terminal,
          })
          .strict(),
      )
      .min(1)
      .max(16),
    accounting: z
      .object({ knownTerminalUsage: amounts, unsettledAllocation: amounts })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.members.map((member) => member.seatId)).size ===
      value.members.length,
  );
const operation = z.object({ replayed: z.boolean(), group }).strict();
const command = z
  .object({ operationId: id, expectedRevision: integer })
  .strict();

export class DelegationGroupUnsupportedError extends Error {
  constructor() {
    super(
      'This host does not support delegation groups. Updating the host may resolve this.',
    );
    this.name = 'DelegationGroupUnsupportedError';
  }
}
export class DelegationGroupProtocolError extends Error {}
export class DelegationGroupBudgetInsufficientError extends StationHttpError {
  constructor() {
    super(409, 'The group reservations exceed its declared budget.', {
      code: 'group_budget_insufficient',
      failurePhase: 'refused',
    });
    this.name = 'DelegationGroupBudgetInsufficientError';
  }
}

const root = (base: string) => `${base}/api/orchestration/groups`;
const path = (base: string, groupId: string) =>
  `${root(base)}/${encodeURIComponent(id.parse(groupId))}`;
async function request(
  url: string,
  input: unknown | undefined,
  options?: ClientRequestOptions,
): Promise<unknown> {
  try {
    const bounded = {
      ...options,
      maxResponseBytes: DELEGATION_GROUP_LIMITS.responseBytes,
    };
    if (input === undefined)
      return await readEnvelopeOrThrow(await getJson(url, bounded));
    if (
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
      DELEGATION_GROUP_LIMITS.requestBytes
    )
      throw new DelegationGroupProtocolError(
        'Delegation group request exceeds its byte limit.',
      );
    return await readEnvelopeOrThrow(
      await mutateJson(url, 'POST', bounded, input),
    );
  } catch (error) {
    if (
      error instanceof StationHttpError &&
      error.status === 409 &&
      error.code === 'group_budget_insufficient' &&
      error.failurePhase === 'refused'
    )
      throw new DelegationGroupBudgetInsufficientError();
    if (error instanceof StationHttpError && error.status === 404)
      throw new DelegationGroupUnsupportedError();
    throw error;
  }
}
function sameGroup(value: DelegationGroupView, groupId: string) {
  if (value.groupId !== groupId)
    throw new DelegationGroupProtocolError('Unexpected delegation group.');
  return value;
}
export async function createDelegationGroup(
  base: string,
  input: DelegationGroupCreateInput,
  options?: ClientRequestOptions,
): Promise<DelegationGroupOperationResult> {
  const sent = parseDelegationGroupInput(input);
  return operation.parse(await request(root(base), sent, options));
}
export function parseDelegationGroupInput(
  input: unknown,
): DelegationGroupCreateInput {
  const sent = parseReportGroupInput(input);
  if (sent.continuation !== undefined)
    throw new DelegationGroupProtocolError(
      'Portable continuation is not supported.',
    );
  return sent;
}
export async function getDelegationGroup(
  base: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<DelegationGroupView> {
  return sameGroup(
    group.parse(await request(path(base, groupId), undefined, options)),
    groupId,
  );
}
export async function listDelegationGroups(
  base: string,
  afterGroupId?: string,
  options?: ClientRequestOptions,
): Promise<DelegationGroupListPage> {
  const query =
    afterGroupId === undefined
      ? ''
      : `?afterGroupId=${encodeURIComponent(id.parse(afterGroupId))}`;
  const page = z
    .object({
      groups: z.array(group).max(DELEGATION_GROUP_LIMITS.pageSize),
      nextGroupId: id.nullable(),
      hasMore: z.boolean(),
    })
    .strict()
    .parse(await request(`${root(base)}${query}`, undefined, options));
  if (
    page.groups.some(
      (value, index) =>
        (afterGroupId !== undefined && value.groupId <= afterGroupId) ||
        (index > 0 && value.groupId <= page.groups[index - 1]!.groupId),
    ) ||
    (page.hasMore &&
      (!page.groups.length ||
        page.nextGroupId !== page.groups[page.groups.length - 1]!.groupId)) ||
    (!page.hasMore && page.nextGroupId !== null)
  )
    throw new DelegationGroupProtocolError(
      'Invalid delegation group list cursor.',
    );
  return page;
}
async function mutate(
  base: string,
  groupId: string,
  action: 'run' | 'cancel',
  input: DelegationGroupCommandInput,
  options?: ClientRequestOptions,
): Promise<DelegationGroupOperationResult> {
  const result = operation.parse(
    await request(
      `${path(base, groupId)}/${action}`,
      command.parse(input),
      options,
    ),
  );
  sameGroup(result.group, groupId);
  return result;
}
export const runDelegationGroup = (
  base: string,
  groupId: string,
  input: DelegationGroupCommandInput,
  options?: ClientRequestOptions,
) => mutate(base, groupId, 'run', input, options);
export const cancelDelegationGroup = (
  base: string,
  groupId: string,
  input: DelegationGroupCommandInput,
  options?: ClientRequestOptions,
) => mutate(base, groupId, 'cancel', input, options);

export async function readDelegationGroupEvents(
  base: string,
  groupId: string,
  afterRevision = 0,
  options?: ClientRequestOptions,
): Promise<DelegationGroupEventPage> {
  integer.parse(afterRevision);
  const page = z
    .object({
      groupId: id,
      afterRevision: integer,
      nextRevision: integer,
      hasMore: z.boolean(),
      events: z
        .array(
          z
            .object({
              revision: integer,
              kind: id,
              seatId: id.optional(),
              invocationId: id.optional(),
              outcome: z.string().min(1).max(128).optional(),
            })
            .strict(),
        )
        .max(DELEGATION_GROUP_LIMITS.pageSize),
    })
    .strict()
    .parse(
      await request(
        `${path(base, groupId)}/events?afterRevision=${afterRevision}`,
        undefined,
        options,
      ),
    );
  if (
    page.groupId !== groupId ||
    page.afterRevision !== afterRevision ||
    page.nextRevision < afterRevision ||
    page.events.some(
      (event, index) =>
        event.revision !==
          1 + (index ? page.events[index - 1]!.revision : afterRevision) ||
        event.revision > page.nextRevision,
    ) ||
    page.nextRevision !==
      (page.events[page.events.length - 1]?.revision ?? afterRevision) ||
    (page.hasMore && page.nextRevision === afterRevision)
  )
    throw new DelegationGroupProtocolError(
      'Invalid delegation group event cursor.',
    );
  return page;
}
export async function readDelegationGroupMemberEvents(
  base: string,
  groupId: string,
  seatId: string,
  afterSequence = 0,
  options?: ClientRequestOptions,
): Promise<DelegationGroupMemberEventPage> {
  integer.parse(afterSequence);
  const page = z
    .object({
      groupId: id,
      seatId: id,
      nextSequence: integer,
      hasMore: z.boolean(),
      events: z
        .array(
          z
            .object({
              sequence: integer,
              eventId: id,
              kind: id,
              turnId: id.optional(),
              inputRequest: z
                .object({
                  requestId: id,
                  requestEventId: id,
                  form: z.unknown().transform((value) => {
                    const form = readInputRequestForm(value);
                    if (!form)
                      throw new DelegationGroupProtocolError(
                        'Invalid input request.',
                      );
                    return form;
                  }),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .max(DELEGATION_GROUP_LIMITS.pageSize),
    })
    .strict()
    .parse(
      await request(
        `${path(base, groupId)}/members/${encodeURIComponent(id.parse(seatId))}/events?afterSequence=${afterSequence}`,
        undefined,
        options,
      ),
    );
  if (
    page.groupId !== groupId ||
    page.seatId !== seatId ||
    page.nextSequence < afterSequence ||
    page.events.some(
      (event, index) =>
        event.sequence <=
          (index ? page.events[index - 1]!.sequence : afterSequence) ||
        event.sequence > page.nextSequence,
    ) ||
    (page.hasMore && page.nextSequence === afterSequence)
  )
    throw new DelegationGroupProtocolError('Invalid member event cursor.');
  return page;
}
export async function readDelegationGroupMemberOutput(
  base: string,
  groupId: string,
  seatId: string,
  options?: ClientRequestOptions & { afterCodeUnit?: number },
): Promise<DelegationGroupRawOutputResult> {
  const { afterCodeUnit = 0, ...requestOptions } = options ?? {};
  integer.parse(afterCodeUnit);
  const result = z
    .object({
      groupId: id,
      seatId: id,
      invocationId: id,
      text: z.string().max(DELEGATION_GROUP_LIMITS.outputPageCodeUnits),
      afterCodeUnit: integer,
      nextCodeUnit: integer,
      hasMore: z.boolean(),
      modelId: z.string().min(1).max(512),
      usage: amounts,
    })
    .strict()
    .parse(
      await request(
        `${path(base, groupId)}/members/${encodeURIComponent(id.parse(seatId))}/output?afterCodeUnit=${afterCodeUnit}`,
        undefined,
        requestOptions,
      ),
    );
  if (
    result.groupId !== groupId ||
    result.seatId !== seatId ||
    result.afterCodeUnit !== afterCodeUnit ||
    result.nextCodeUnit !== afterCodeUnit + result.text.length ||
    (result.hasMore && result.nextCodeUnit <= afterCodeUnit)
  )
    throw new DelegationGroupProtocolError('Unexpected member output.');
  return result;
}
