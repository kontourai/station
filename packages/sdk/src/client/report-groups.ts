import {
  assertReportGroupContinuation,
  REPORT_GROUP_CONTEXT_LIMITS,
  REPORT_GROUP_CONTINUATION_LIMITS,
  REPORT_GROUP_LIMITS,
  REPORT_GROUP_RENEWAL_LIMITS,
  REPORT_GROUP_VERSION,
  type ReportGroupAccountingRecoveryInput,
  type ReportGroupAccountingRecoveryResult,
  type ReportGroupCancelInput,
  type ReportGroupCancelResult,
  type ReportGroupContextCheckpoint,
  type ReportGroupContextSyncInput,
  type ReportGroupEventPage,
  type ReportGroupFinalizeCancelInput,
  type ReportGroupFinalizeContinuationInput,
  type ReportGroupFinalizeSyncInput,
  type ReportGroupInput,
  type ReportGroupInputSyncInput,
  type ReportGroupListPage,
  type ReportGroupNarrowInput,
  type ReportGroupOperation,
  type ReportGroupReportInput,
  type ReportGroupReportOperation,
  type ReportGroupResultPage,
  type ReportGroupView,
  reportGroupStreamCursor,
} from '@kontourai/station-contracts/report-group';
import { z } from 'zod/v3';
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

export type {
  ReportGroupAccountingRecoveryInput,
  ReportGroupAccountingRecoveryResult,
  ReportGroupCancelInput,
  ReportGroupCancelResult,
  ReportGroupContextCheckpoint,
  ReportGroupContextSyncInput,
  ReportGroupContextSyncView,
  ReportGroupContinuation,
  ReportGroupEventPage,
  ReportGroupFinalizeCancelInput,
  ReportGroupFinalizeContinuationInput,
  ReportGroupFinalizeSyncInput,
  ReportGroupInput,
  ReportGroupInputSyncInput,
  ReportGroupListPage,
  ReportGroupNarrowInput,
  ReportGroupOperation,
  ReportGroupReportInput,
  ReportGroupReportOperation,
  ReportGroupResultPage,
  ReportGroupView,
} from '@kontourai/station-contracts/report-group';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const integer = z.number().int().nonnegative().safe();
const revision = integer.max(1024);
const amounts = z
  .object({ inputTokens: integer, outputTokens: integer, costMicros: integer })
  .strict();
const reference = z
  .object({
    id,
    domain: z.string().min(1).max(128),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
const inputSchema = z
  .object({
    operationId: id,
    projectSlug: id,
    resourceId: id.optional(),
    flow: z
      .object({ runId: id, steps: z.record(id, id) })
      .strict()
      .optional(),
    continuation: z
      .object({
        attemptsPerMember: z
          .number()
          .int()
          .min(1)
          .max(REPORT_GROUP_CONTINUATION_LIMITS.attemptsPerMember),
        maxRounds: z
          .number()
          .int()
          .min(1)
          .max(REPORT_GROUP_CONTINUATION_LIMITS.maxRounds),
        maxSyncs: z
          .number()
          .int()
          .min(0)
          .max(REPORT_GROUP_CONTINUATION_LIMITS.maxSyncs),
        maxRenewals: z
          .number()
          .int()
          .min(0)
          .max(REPORT_GROUP_CONTINUATION_LIMITS.maxRenewals),
        maxEvaluations: z
          .number()
          .int()
          .min(0)
          .max(REPORT_GROUP_CONTINUATION_LIMITS.maxEvaluations),
        maxRecoveries: z
          .number()
          .int()
          .min(0)
          .max(REPORT_GROUP_CONTINUATION_LIMITS.maxRecoveries),
      })
      .strict()
      .optional(),
    deadlineAt: integer,
    maxConcurrent: z.number().int().min(1).max(16),
    budget: amounts,
    members: z
      .array(
        z
          .object({
            seatId: id,
            agentId: id,
            brief: z.string().min(1).max(65536),
            maxOutputTokens: z.number().int().min(1).max(128000),
            input: z.literal('operator-clarification-v1').optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
const viewSchema = z
  .object({
    version: z.literal(REPORT_GROUP_VERSION),
    groupId: id,
    operationId: id,
    revision,
    topology: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('independent-advisory') }).strict(),
      z.object({ kind: z.literal('flow'), runId: id }).strict(),
    ]),
    execution: z.enum(['not-created', 'idle', 'returned', 'unknown']),
    cancellation: z.enum(['none', 'pending', 'requested']),
    authorityRevoked: z.boolean(),
    acceptance: z.literal('unassessed'),
    contextSyncAllowance: z
      .object({
        maximumOperations: integer.max(
          REPORT_GROUP_CONTINUATION_LIMITS.maxSyncs,
        ),
        recordedOperations: integer.max(
          REPORT_GROUP_CONTINUATION_LIMITS.maxSyncs,
        ),
      })
      .strict()
      .optional(),
    contextSyncs: z
      .array(
        z
          .object({
            operationKey: id,
            seatId: id,
            flowHead: z.string().regex(/^[a-f0-9]{64}$/),
            state: z.enum([
              'pending',
              'prepared',
              'acknowledged',
              'incomplete',
            ]),
            reason: z
              .enum([
                'exact_ack',
                'ack_mismatch',
                'unexpected_tools',
                'execution_incomplete',
              ])
              .nullable(),
            preparedDigest: z
              .string()
              .regex(/^sha256:[a-f0-9]{64}$/)
              .nullable(),
            attempts: z
              .array(
                z
                  .object({
                    invocationId: id,
                    allocation: amounts,
                    usage: amounts.nullable(),
                    accountingTerminal: z.boolean(),
                    terminal: reference.nullable(),
                  })
                  .strict(),
              )
              .max(2)
              .nullable(),
          })
          .strict(),
      )
      .max(REPORT_GROUP_CONTINUATION_LIMITS.maxSyncs)
      .optional(),
    accounting: z
      .object({
        invocationCount: integer.max(
          REPORT_GROUP_CONTINUATION_LIMITS.maxAttempts,
        ),
        unsettledInvocations: integer.max(
          REPORT_GROUP_CONTINUATION_LIMITS.maxAttempts,
        ),
        knownTerminalUsage: amounts,
        unsettledAllocation: amounts,
      })
      .strict()
      .optional(),
    members: z
      .array(
        z
          .object({
            seatId: id,
            agentId: id,
            taskId: id,
            clientTurnId: id,
            requestedModelId: z.string().min(1).max(512),
            attempts: z
              .array(
                z
                  .object({
                    invocationId: id,
                    observation: reference.nullable(),
                    terminal: reference.nullable(),
                    allocation: amounts.nullable(),
                    usage: amounts.nullable(),
                    accountingTerminal: z.boolean(),
                  })
                  .strict(),
              )
              .max(REPORT_GROUP_CONTINUATION_LIMITS.attemptsPerMember),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((view, context) => {
    const syncs = view.contextSyncs ?? [];
    const invalid = syncs.some(
      (sync) =>
        !view.members.some((m) => m.seatId === sync.seatId) ||
        (sync.state === 'pending'
          ? sync.reason !== null ||
            sync.preparedDigest !== null ||
            sync.attempts !== null
          : sync.reason === null ||
            sync.preparedDigest === null ||
            sync.attempts === null) ||
        (sync.state === 'acknowledged' &&
          (sync.reason !== 'exact_ack' ||
            !sync.attempts?.length ||
            sync.attempts.some(
              (a) =>
                !a.accountingTerminal ||
                a.usage === null ||
                a.terminal === null,
            ))) ||
        (sync.state === 'incomplete' && sync.reason === 'exact_ack') ||
        (sync.attempts &&
          new Set(sync.attempts.map((a) => a.invocationId)).size !==
            sync.attempts.length),
    );
    if (
      invalid ||
      (view.contextSyncAllowance &&
        (view.topology.kind !== 'flow' ||
          view.contextSyncAllowance.recordedOperations !== syncs.length ||
          view.contextSyncAllowance.recordedOperations >
            view.contextSyncAllowance.maximumOperations)) ||
      (syncs.length > 0 && view.topology.kind !== 'flow') ||
      new Set(syncs.map((sync) => sync.operationKey)).size !== syncs.length ||
      (view.accounting &&
        view.accounting.unsettledInvocations > view.accounting.invocationCount)
    )
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent report continuation observations.',
      });
  });
const operation = z
  .object({ replayed: z.boolean(), group: viewSchema })
  .strict();
const list = z
  .object({
    groups: z.array(viewSchema).max(8),
    hasMore: z.boolean(),
    nextGroupId: id.nullable(),
  })
  .strict();
const cancelInput = z
  .object({ operationKey: id, expectedRevision: revision })
  .strict();
const canceled = z
  .object({
    replayed: z.boolean(),
    revision,
    cancellation: z.enum(['none', 'pending', 'requested']),
  })
  .strict();
const pageSchema = z
  .object({
    groupId: id,
    afterRevision: revision,
    nextRevision: revision,
    revision,
    events: z
      .array(
        z
          .object({
            revision,
            kind: z.string().min(1).max(64),
            commandKind: z.string().min(1).max(64).optional(),
            seatId: id.optional(),
            invocationId: id.optional(),
          })
          .strict(),
      )
      .max(64),
    unavailable: z
      .array(
        z
          .object({ cursor: revision, code: z.literal('item_too_large') })
          .strict(),
      )
      .max(64),
    hasMore: z.boolean(),
  })
  .strict();
const result = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('failure'),
      code: z.literal('report_attempt_unavailable'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('result'),
      groupId: id,
      seatId: id,
      invocationId: id,
      modelId: z.string().min(1).max(512),
      text: z.string().max(REPORT_GROUP_LIMITS.resultCodeUnits),
      afterOffset: integer,
      nextOffset: integer,
      hasMore: z.boolean(),
      usage: amounts,
    })
    .strict(),
]);
export class ReportGroupProtocolError extends Error {}
const root = (base: string) => `${base}/api/orchestration/report-groups`;
const path = (base: string, groupId: string) =>
  `${root(base)}/${encodeURIComponent(id.parse(groupId))}`;
async function read(url: string, options?: ClientRequestOptions) {
  return readEnvelopeOrThrow<unknown>(
    await getJson(url, {
      ...options,
      maxResponseBytes: REPORT_GROUP_LIMITS.pageBytes,
    }),
  );
}
async function post(
  url: string,
  value: unknown,
  options?: ClientRequestOptions,
  requestBytes: number = REPORT_GROUP_LIMITS.requestBytes,
) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > requestBytes)
    throw new ReportGroupProtocolError(
      'Report group request exceeds its byte limit.',
    );
  return readEnvelopeOrThrow<unknown>(
    await mutateJson(
      url,
      'POST',
      { ...options, maxResponseBytes: REPORT_GROUP_LIMITS.pageBytes },
      value,
    ),
  );
}
export function parseReportGroupInput(value: unknown): ReportGroupInput {
  const input = inputSchema.parse(value);
  assertReportGroupContinuation(input);
  return input;
}
const syncInput = z
  .object({
    operationKey: id,
    expectedRevision: revision,
    seatId: id,
    flowHead: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().min(1).max(65_536),
  })
  .strict();
export function parseReportGroupContextSyncInput(
  input: unknown,
): ReportGroupContextSyncInput {
  const value = syncInput.parse(input);
  if (new TextEncoder().encode(value.text).byteLength > 65_536)
    throw new ReportGroupProtocolError(
      'Report context exceeds its byte limit.',
    );
  return value;
}
export async function readReportGroupContextCheckpoint(
  base: string,
  groupId: string,
  input: { seatId: string; expectedRevision: number },
  options?: ClientRequestOptions,
): Promise<ReportGroupContextCheckpoint> {
  const seatId = id.parse(input.seatId);
  const expectedRevision = revision.parse(input.expectedRevision);
  const result = z
    .object({
      groupId: id,
      seatId: id,
      revision,
      flowHead: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(
      await post(
        `${path(base, groupId)}/members/${encodeURIComponent(seatId)}/context-checkpoint`,
        { expectedRevision },
        options,
      ),
    );
  if (
    result.groupId !== groupId ||
    result.seatId !== seatId ||
    result.revision !== expectedRevision
  )
    throw new ReportGroupProtocolError('Unexpected report context checkpoint.');
  return result;
}
export async function narrowReportGroupAfterInput(
  base: string,
  groupId: string,
  input: ReportGroupNarrowInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupOperation> {
  const sent = z
    .object({
      operationKey: id.max(REPORT_GROUP_RENEWAL_LIMITS.operationKeyCodeUnits),
      expectedRevision: integer,
      seatId: id,
    })
    .strict()
    .parse(structuredClone(input));
  const result = operation.parse(
    await post(
      `${path(base, groupId)}/input/narrow`,
      sent,
      { timeoutMs: null, ...options },
      REPORT_GROUP_RENEWAL_LIMITS.requestBytes,
    ),
  );
  if (
    result.group.groupId !== groupId ||
    result.group.topology.kind !== 'flow' ||
    result.group.revision < sent.expectedRevision ||
    !result.group.members.some((member) => member.seatId === sent.seatId)
  )
    throw new ReportGroupProtocolError('Unexpected report narrowing result.');
  return result;
}

export async function continueReportGroupReport(
  base: string,
  groupId: string,
  input: ReportGroupReportInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupReportOperation> {
  const sent = z
    .object({
      operationKey: id,
      expectedRevision: revision,
      seatId: id,
      flowHead: z.string().regex(/^[a-f0-9]{64}$/),
      syncOperationKey: id,
      previousInvocationId: id,
      retryRef: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(structuredClone(input));
  const result = operation
    .extend({ operationKey: id, seatId: id, invocationId: id })
    .strict()
    .parse(
      await post(
        `${path(base, groupId)}/report`,
        sent,
        { timeoutMs: null, ...options },
        REPORT_GROUP_RENEWAL_LIMITS.requestBytes,
      ),
    );
  const member = result.group.members.find(
    (entry) => entry.seatId === sent.seatId,
  );
  if (
    result.operationKey !== sent.operationKey ||
    result.seatId !== sent.seatId ||
    result.invocationId === sent.previousInvocationId ||
    result.group.groupId !== groupId ||
    result.group.topology.kind !== 'flow' ||
    !member ||
    result.group.revision < sent.expectedRevision ||
    !member.attempts.some(
      (entry) => entry.invocationId === sent.previousInvocationId,
    ) ||
    !member.attempts.some((entry) => entry.invocationId === result.invocationId)
  )
    throw new ReportGroupProtocolError('Unexpected continued report result.');
  return result;
}

export async function syncReportGroupAfterInput(
  base: string,
  groupId: string,
  input: ReportGroupInputSyncInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupOperation> {
  const sent = z
    .object({
      operationKey: id,
      expectedRevision: revision,
      seatId: id,
      flowHead: z.string().regex(/^[a-f0-9]{64}$/),
      renewalOperationKey: id.max(
        REPORT_GROUP_RENEWAL_LIMITS.operationKeyCodeUnits,
      ),
    })
    .strict()
    .parse(structuredClone(input));
  const result = operation.parse(
    await post(
      `${path(base, groupId)}/input/sync`,
      sent,
      { timeoutMs: null, ...options },
      REPORT_GROUP_RENEWAL_LIMITS.requestBytes,
    ),
  );
  const sync = result.group.contextSyncs?.find(
    (entry) =>
      entry.operationKey === sent.operationKey && entry.seatId === sent.seatId,
  );
  if (
    result.group.groupId !== groupId ||
    !sync ||
    sync.flowHead !== sent.flowHead ||
    (!result.replayed && sync.state !== 'acknowledged')
  )
    throw new ReportGroupProtocolError('Unexpected report input sync result.');
  return result;
}

export async function syncReportGroupContext(
  base: string,
  groupId: string,
  input: ReportGroupContextSyncInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupOperation> {
  const sent = parseReportGroupContextSyncInput(input);
  const result = operation.parse(
    await post(
      `${path(base, groupId)}/sync`,
      sent,
      {
        timeoutMs: null,
        ...options,
      },
      REPORT_GROUP_CONTEXT_LIMITS.requestBytes,
    ),
  );
  const sync = result.group.contextSyncs?.find(
    (s) => s.operationKey === sent.operationKey && s.seatId === sent.seatId,
  );
  if (
    result.group.groupId !== groupId ||
    !sync ||
    sync.flowHead !== sent.flowHead ||
    (!result.replayed && sync.state !== 'acknowledged')
  )
    throw new ReportGroupProtocolError('Unexpected context sync operation.');
  return result;
}
export class ReportGroupContinuationUnsupportedError extends Error {
  constructor() {
    super(
      'This host does not support report continuation finalization. Updating the host may resolve this.',
    );
  }
}

export async function finalizeReportGroupContinuation(
  base: string,
  groupId: string,
  input: ReportGroupFinalizeContinuationInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupOperation> {
  const sent = cancelInput
    .extend({ continuationOperationKey: id })
    .strict()
    .parse(input);
  let response: unknown;
  try {
    response = await post(
      `${path(base, groupId)}/continuation/finalize`,
      sent,
      options,
    );
  } catch (error) {
    if (error instanceof StationHttpError && error.status === 404)
      throw new ReportGroupContinuationUnsupportedError();
    throw error;
  }
  const result = operation.parse(response);
  if (result.group.groupId !== groupId)
    throw new ReportGroupProtocolError('Unexpected continuation group.');
  return result;
}

export async function finalizeReportGroupSync(
  base: string,
  groupId: string,
  input: ReportGroupFinalizeSyncInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupOperation> {
  const sent = cancelInput
    .extend({
      syncOperationKey: id,
      preparedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict()
    .parse(input);
  const result = operation.parse(
    await post(`${path(base, groupId)}/sync/finalize`, sent, {
      timeoutMs: null,
      ...options,
    }),
  );
  if (
    result.group.groupId !== groupId ||
    !result.group.contextSyncs?.some(
      (s) =>
        s.operationKey === sent.syncOperationKey &&
        s.preparedDigest === sent.preparedDigest &&
        ['acknowledged', 'incomplete'].includes(s.state),
    )
  )
    throw new ReportGroupProtocolError('Unexpected context sync finalization.');
  return result;
}
/** Aborting stops request admission/supervision; it does not establish physical termination. */
export async function createReportGroup(
  base: string,
  input: ReportGroupInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupOperation> {
  const sent = parseReportGroupInput(input);
  const result = operation.parse(
    await post(root(base), sent, { timeoutMs: null, ...options }),
  );
  if (result.group.operationId !== sent.operationId)
    throw new ReportGroupProtocolError('Unexpected report group operation.');
  return result;
}
export async function getReportGroup(
  base: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<ReportGroupView | null> {
  const parsed = viewSchema
    .nullable()
    .parse(await read(path(base, groupId), options));
  if (parsed && parsed.groupId !== groupId)
    throw new ReportGroupProtocolError('Unexpected report group.');
  return parsed;
}
export async function listReportGroups(
  base: string,
  afterGroupId?: string,
  options?: ClientRequestOptions,
): Promise<ReportGroupListPage> {
  const suffix =
    afterGroupId === undefined
      ? ''
      : `?afterGroupId=${encodeURIComponent(id.parse(afterGroupId))}`;
  const parsed = list.parse(await read(root(base) + suffix, options));
  if (
    parsed.groups.some(
      (group, index) =>
        (afterGroupId !== undefined && group.groupId <= afterGroupId) ||
        (index > 0 && group.groupId <= parsed.groups[index - 1].groupId),
    ) ||
    (parsed.hasMore
      ? parsed.nextGroupId === null ||
        parsed.nextGroupId !== parsed.groups[parsed.groups.length - 1]?.groupId
      : parsed.nextGroupId !== null)
  )
    throw new ReportGroupProtocolError('Invalid report group list page.');
  return parsed;
}
export async function cancelReportGroup(
  base: string,
  groupId: string,
  input: ReportGroupCancelInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupCancelResult> {
  return canceled.parse(
    await post(`${path(base, groupId)}/cancel`, cancelInput.parse(input), {
      timeoutMs: null,
      ...options,
    }),
  );
}
/** Explicitly confirm a retained cancellation request; this never resends member interrupts. */
export async function finalizeReportGroupCancel(
  base: string,
  groupId: string,
  input: ReportGroupFinalizeCancelInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupCancelResult> {
  const command = cancelInput
    .extend({ cancelOperationKey: id })
    .strict()
    .parse(input);
  return canceled.parse(
    await post(`${path(base, groupId)}/cancel/finalize`, command, {
      timeoutMs: null,
      ...options,
    }),
  );
}
function page(value: unknown, groupId: string): ReportGroupEventPage {
  const parsed = pageSchema.parse(value);
  if (
    parsed.groupId !== groupId ||
    parsed.nextRevision < parsed.afterRevision ||
    parsed.nextRevision > parsed.revision ||
    parsed.hasMore !== parsed.nextRevision < parsed.revision ||
    (parsed.hasMore && parsed.nextRevision === parsed.afterRevision)
  )
    throw new ReportGroupProtocolError('Invalid report group event cursor.');
  const cursors = [
    ...parsed.events.map((e) => e.revision),
    ...parsed.unavailable.map((e) => e.cursor),
  ].sort((a, b) => a - b);
  let expected = parsed.afterRevision;
  for (const cursor of cursors)
    if (cursor !== ++expected)
      throw new ReportGroupProtocolError(
        'Invalid report group event sequence.',
      );
  if (
    expected !== parsed.nextRevision ||
    parsed.events.some(
      (e, i) => i > 0 && e.revision <= parsed.events[i - 1].revision,
    )
  )
    throw new ReportGroupProtocolError('Invalid report group event page.');
  return parsed;
}
export async function readReportGroupEvents(
  base: string,
  groupId: string,
  afterRevision = 0,
  options?: ClientRequestOptions,
): Promise<ReportGroupEventPage> {
  revision.parse(afterRevision);
  const parsed = page(
    await read(
      `${path(base, groupId)}/events?afterRevision=${afterRevision}`,
      options,
    ),
    groupId,
  );
  if (parsed.afterRevision !== afterRevision)
    throw new ReportGroupProtocolError('Unexpected report group event cursor.');
  return parsed;
}
export async function readReportGroupResult(
  base: string,
  groupId: string,
  seatId: string,
  invocationId: string,
  afterOffset = 0,
  options?: ClientRequestOptions,
): Promise<ReportGroupResultPage> {
  integer.parse(afterOffset);
  const parsed = result.parse(
    await read(
      `${path(base, groupId)}/members/${encodeURIComponent(id.parse(seatId))}/results/${encodeURIComponent(id.parse(invocationId))}?afterOffset=${afterOffset}`,
      options,
    ),
  );
  if (
    parsed.kind === 'result' &&
    (parsed.groupId !== groupId ||
      parsed.seatId !== seatId ||
      parsed.invocationId !== invocationId ||
      parsed.afterOffset !== afterOffset ||
      parsed.nextOffset !== afterOffset + parsed.text.length ||
      (parsed.hasMore && parsed.text.length === 0))
  )
    throw new ReportGroupProtocolError('Invalid report group result page.');
  return parsed;
}
export function subscribeReportGroupEvents(
  base: string,
  groupId: string,
  afterRevision: number,
  callbacks: {
    onPage(page: ReportGroupEventPage): void;
    onError?(error: unknown): void;
    onOpen?(): void;
    onTerminal?(error: unknown): void;
  },
  options?: ClientRequestOptions,
): FetchSseConnection {
  let cursor = revision.parse(afterRevision);
  return fetchSSE(
    `${path(base, groupId)}/events/stream?afterRevision=${cursor}`,
    {
      ...options,
      maxFrameBytes: REPORT_GROUP_LIMITS.frameBytes,
      onOpen: callbacks.onOpen,
      onError: callbacks.onError,
      onTerminal: callbacks.onTerminal,
      stopOnError: (error) =>
        error instanceof ReportGroupProtocolError ||
        error instanceof z.ZodError ||
        error instanceof StationSseProtocolError ||
        error instanceof StationRequestAuthorityError ||
        (error instanceof StationHttpError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429),
      validateCheckpoint(checkpoint) {
        if (
          checkpoint.id !== undefined &&
          checkpoint.id !== reportGroupStreamCursor(groupId, cursor)
        )
          throw new ReportGroupProtocolError(
            'Invalid report group stream checkpoint.',
          );
      },
      onMessage(message) {
        if (message.event === 'unavailable')
          throw new ReportGroupProtocolError(
            'Report group stream unavailable.',
          );
        if (message.event !== 'report-group-events') return false;
        if (
          new TextEncoder().encode(message.data).byteLength >
          REPORT_GROUP_LIMITS.pageBytes
        )
          throw new ReportGroupProtocolError(
            'Report group event page too large.',
          );
        let decoded: unknown;
        try {
          decoded = JSON.parse(message.data);
        } catch {
          throw new ReportGroupProtocolError(
            'Invalid report group event JSON.',
          );
        }
        const parsed = page(decoded, groupId);
        if (
          message.id !==
            reportGroupStreamCursor(groupId, parsed.nextRevision) ||
          parsed.nextRevision < cursor ||
          parsed.afterRevision > cursor
        )
          throw new ReportGroupProtocolError(
            'Invalid report group stream cursor.',
          );
        if (parsed.nextRevision === cursor && parsed.events.length > 0)
          return false;
        if (parsed.nextRevision > cursor && parsed.afterRevision !== cursor)
          throw new ReportGroupProtocolError('Report group stream gap.');
        callbacks.onPage(parsed);
        cursor = parsed.nextRevision;
        return true;
      },
    },
  );
}

export class ReportGroupRecoveryUnsupportedError extends Error {
  constructor() {
    super(
      'This host does not support report accounting recovery. Updating the host may resolve this.',
    );
  }
}
export async function recoverReportGroupAccounting(
  base: string,
  groupId: string,
  input: ReportGroupAccountingRecoveryInput,
  options?: ClientRequestOptions,
): Promise<ReportGroupAccountingRecoveryResult> {
  const sent = z
    .object({ seatId: id, invocationId: id, operationKey: id })
    .strict()
    .parse(input);
  let data: unknown;
  try {
    data = await post(`${path(base, groupId)}/accounting/recover`, sent, {
      timeoutMs: null,
      ...options,
    });
  } catch (error) {
    if (error instanceof StationHttpError && error.status === 404)
      throw new ReportGroupRecoveryUnsupportedError();
    throw error;
  }
  const result = z
    .object({
      groupId: id,
      seatId: id,
      invocationId: id,
      operationKey: id,
      replayed: z.boolean(),
      status: z.enum(['settled', 'held']),
      reason: z.enum([
        'exact-settlement',
        'usage-unknown',
        'usage-exceeds-reservation',
      ]),
      accounting: amounts.nullable(),
      receipt: reference,
    })
    .strict()
    .parse(data);
  if (
    result.groupId !== groupId ||
    result.seatId !== sent.seatId ||
    result.invocationId !== sent.invocationId ||
    result.operationKey !== sent.operationKey ||
    (result.status === 'settled') !== (result.reason === 'exact-settlement') ||
    (result.accounting === null) !== (result.reason === 'usage-unknown')
  )
    throw new ReportGroupProtocolError(
      'Unexpected report accounting recovery.',
    );
  return result;
}
