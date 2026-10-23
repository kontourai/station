import {
  REPORT_GROUP_LIMITS,
  REPORT_GROUP_VERSION,
  type ReportGroupCancelInput,
  type ReportGroupCancelResult,
  type ReportGroupEventPage,
  type ReportGroupFinalizeCancelInput,
  type ReportGroupInput,
  type ReportGroupListPage,
  type ReportGroupOperation,
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
  ReportGroupCancelInput,
  ReportGroupCancelResult,
  ReportGroupEventPage,
  ReportGroupFinalizeCancelInput,
  ReportGroupInput,
  ReportGroupListPage,
  ReportGroupOperation,
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
              .max(1),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
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
) {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    REPORT_GROUP_LIMITS.requestBytes
  )
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
  return inputSchema.parse(value);
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
