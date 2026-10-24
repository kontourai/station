import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  CliSessionGroupCreateInput,
  CliSessionGroupEventPage,
  CliSessionGroupListPage,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import {
  CLI_SESSION_GROUP_EVENT_LIMITS,
  cliSessionGroupStreamCursor,
} from '@kontourai/station-contracts/delegation-group';
import type { EnsembleCliSessionGroupInput } from '@kontourai/station-contracts/ensemble';
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
  CliSessionGroupCreateInput,
  CliSessionGroupListPage,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';

const text = z.string().min(1).max(512);
const seatId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const inputSchema = z
  .object({
    operationId: seatId,
    maxConcurrent: z.number().int().min(1).max(32),
    maxDispatches: z.number().int().min(0).max(32).optional(),
    deadlineAt: z.number().int().positive(),
    members: z
      .array(
        z
          .object({
            seatId,
            prompt: z.string().trim().min(1).max(100_000),
            needs: z.array(seatId).max(32).optional(),
            parentTaskId: text.optional(),
            target: z
              .object({
                environment: z
                  .object({ kind: z.literal('current') })
                  .strict()
                  .optional(),
                agent: z.string().min(1).max(64).transform(agentId),
                expectedEngine: z
                  .object({
                    kind: z.literal('connection'),
                    connectionId: text.transform(engineConnectionId),
                  })
                  .strict(),
                model: z
                  .object({
                    override: text.optional(),
                    options: z.record(z.unknown()).optional(),
                  })
                  .strict()
                  .optional(),
                workspace: z
                  .discriminatedUnion('kind', [
                    z
                      .object({
                        kind: z.literal('project'),
                        projectSlug: text,
                        cwd: z.string().min(1).max(4096).optional(),
                      })
                      .strict(),
                    z
                      .object({
                        kind: z.literal('directory'),
                        cwd: z.string().min(1).max(4096),
                      })
                      .strict(),
                  ])
                  .optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
const syncSchema = z
  .object({
    operationId: seatId,
    runId: seatId,
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    timestamp: z.string().datetime(),
    status: z.enum(['syncing', 'acknowledged', 'incomplete']),
    members: z
      .array(
        z
          .object({
            seatId: seatId,
            status: z.enum(['pending', 'acknowledged', 'failed', 'unknown']),
            attempts: z.number().int().min(0).max(2),
            timestamp: z.string().datetime().optional(),
            turnId: z.string().min(1).max(512).optional(),
            terminalEventId: z.string().min(1).max(512).optional(),
            toolCalls: z.number().int().min(0).max(1_000_000).optional(),
            nativeIdentityHash: z
              .string()
              .regex(/^sha256:[0-9a-f]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
const viewSchema = z
  .object({
    version: z.literal('station.cli-session-group/v1'),
    groupId: seatId,
    revision: z.number().int().nonnegative(),
    supervision: z.enum(['active', 'not-running']),
    cancelled: z.boolean(),
    deadlineAt: z.number().int().positive(),
    maxConcurrent: z.number().int().min(1).max(32),
    maxDispatches: z.number().int().min(0).max(32).optional(),
    dispatchCount: z.number().int().min(0).max(32),
    admissionClosed: z.literal('dispatch-limit-exhausted').optional(),
    contextSync: syncSchema.optional(),
    preset: z
      .object({
        presetId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        sha256: z
          .string()
          .max(71)
          .regex(/^sha256:[0-9a-f]{64}$/),
        stationmaster: seatId,
        members: z
          .array(
            z
              .object({
                seatId,
                codename: z
                  .string()
                  .min(1)
                  .max(64)
                  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
                color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
                role: z
                  .string()
                  .min(1)
                  .max(512)
                  .refine((value) => value.trim().length > 0),
              })
              .strict(),
          )
          .min(1)
          .max(16)
          .optional(),
      })
      .strict()
      .optional(),
    guarantees: z
      .object({
        authority: z.literal('station-session'),
        portableFlowLineage: z.literal('unbound'),
        dollarCap: z.literal('unavailable'),
        tokenCap: z.literal('unavailable'),
        physicalAttemptCap: z.literal('unavailable'),
        deadline: z.literal('stop-admission-and-request-interruption'),
      })
      .strict(),
    flow: z
      .object({
        runId: seatId,
        definition: z
          .object({ id: seatId, version: text, digest: text })
          .strict(),
        status: text,
      })
      .strict()
      .nullable(),
    acceptance: z.literal('unassessed'),
    members: z
      .array(
        z
          .object({
            seatId,
            needs: z.array(seatId).max(32),
            state: z.enum(['pending', 'launch-intent', 'started', 'terminal']),
            claimId: text.optional(),
            reservedSessionId: text.optional(),
            initialClientTurnId: text.optional(),
            handle: z
              .object({
                taskId: text,
                conversationId: text,
                sessionId: text,
                initialTurnId: text.optional(),
              })
              .strict()
              .optional(),
            outcome: z.enum(['completed', 'failed', 'canceled']).optional(),
            attention: z
              .object({
                kind: z.enum(['needs-input', 'review-pending', 'blocked']),
                observedAt: z.string().datetime(),
                request: z
                  .object({ id: text, eventId: text.optional() })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
            dispatchFailure: z
              .object({
                status: z.number().int().min(400).max(599),
                code: z.string().max(128),
              })
              .strict()
              .optional(),
            terminalEvent: z
              .object({ eventId: text, turnId: text })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

const revisionSchema = z.number().int().nonnegative().safe();
const eventPageSchema: z.ZodType<CliSessionGroupEventPage> = z
  .object({
    groupId: seatId,
    afterRevision: revisionSchema,
    nextRevision: revisionSchema,
    events: z
      .array(
        z
          .object({
            revision: revisionSchema,
            members: z.array(viewSchema.shape.members.element).max(32),
            cancelled: z.boolean().optional(),
            admissionClosed: z.literal('dispatch-limit-exhausted').optional(),
            contextSync: syncSchema.optional(),
            schedule: z
              .array(
                z
                  .object({
                    kind: z.string().max(32),
                    stepId: seatId,
                    claimId: z.string().max(512),
                  })
                  .strict(),
              )
              .max(32),
          })
          .strict(),
      )
      .max(64),
    hasMore: z.boolean(),
    gap: z
      .object({ availableFromRevision: revisionSchema })
      .strict()
      .optional(),
    unavailable: z
      .array(
        z
          .object({ cursor: revisionSchema, code: z.literal('item_too_large') })
          .strict(),
      )
      .max(64),
  })
  .strict();
class CliSessionGroupProtocolError extends Error {}
function eventPage(value: unknown, groupId: string): CliSessionGroupEventPage {
  const page = eventPageSchema.parse(value);
  if (
    page.events.length + page.unavailable.length > 64 ||
    page.events.some(
      (event, index) =>
        index > 0 && event.revision <= page.events[index - 1].revision,
    ) ||
    page.unavailable.some(
      (entry, index) =>
        index > 0 && entry.cursor <= page.unavailable[index - 1].cursor,
    )
  )
    throw new CliSessionGroupProtocolError(
      'Invalid session group event order.',
    );
  if (
    page.groupId !== groupId ||
    page.nextRevision < page.afterRevision ||
    (page.gap && page.gap.availableFromRevision <= page.afterRevision + 1)
  )
    throw new CliSessionGroupProtocolError('Invalid session group event page.');
  let expected = Math.max(
    page.afterRevision,
    (page.gap?.availableFromRevision ?? 1) - 1,
  );
  for (const cursor of [
    ...page.events.map((event) => event.revision),
    ...page.unavailable.map((entry) => entry.cursor),
  ].sort((a, b) => a - b)) {
    if (cursor !== ++expected)
      throw new CliSessionGroupProtocolError(
        'Invalid session group event sequence.',
      );
  }
  if (expected !== page.nextRevision)
    throw new CliSessionGroupProtocolError(
      'Invalid session group event cursor.',
    );
  return page;
}

const ensembleInputSchema = inputSchema
  .omit({ members: true })
  .extend({
    path: z.string().min(1).max(4096).optional(),
    presetJson: z.string().min(1).max(131_072).optional(),
    expectedPresetHash: z
      .string()
      .max(71)
      .regex(/^sha256:[0-9a-f]{64}$/),
    brief: z.string().min(1).max(100_000),
    bindings: z
      .record(
        z.string().min(1).max(64),
        z
          .object({
            target: inputSchema.shape.members.element.shape.target
              .omit({
                model: true,
              })
              .extend({
                workspace:
                  inputSchema.shape.members.element.shape.target.shape.workspace.unwrap(),
              }),
            needs: z.array(seatId).max(16),
          })
          .strict(),
      )
      .refine((bindings) => Object.keys(bindings).length <= 16),
  })
  .strict();

export function parseEnsembleCliSessionGroupInput(
  value: unknown,
): EnsembleCliSessionGroupInput {
  const input = ensembleInputSchema.parse(value);
  if ((input.path === undefined) === (input.presetJson === undefined))
    throw new Error('Select exactly one Ensemble source.');
  return input;
}

/** Local named Agents, with an expected engine and explicit operation identity. */
export function parseCliSessionGroupInput(
  value: unknown,
): CliSessionGroupCreateInput {
  return inputSchema.parse(value);
}
const root = (apiBase: string) => `${apiBase}/api/orchestration/session-groups`;
const groupPath = (apiBase: string, groupId: string) =>
  `${root(apiBase)}/${encodeURIComponent(seatId.parse(groupId))}`;
export async function readCliSessionGroupEvents(
  apiBase: string,
  groupId: string,
  afterRevision = 0,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupEventPage> {
  revisionSchema.parse(afterRevision);
  const response = await getJson(
    `${groupPath(apiBase, groupId)}/events?afterRevision=${afterRevision}`,
    { ...options, maxResponseBytes: 262_144 },
  );
  const page = eventPage(await readEnvelopeOrThrow<unknown>(response), groupId);
  if (page.afterRevision !== afterRevision)
    throw new CliSessionGroupProtocolError(
      'Unexpected session group event cursor.',
    );
  return page;
}

export function subscribeCliSessionGroupEvents(
  apiBase: string,
  groupId: string,
  afterRevision: number,
  callbacks: {
    onPage(page: CliSessionGroupEventPage): void;
    onError?(error: unknown): void;
    onOpen?(): void;
    onTerminal?(error: unknown): void;
  },
  options?: ClientRequestOptions,
): FetchSseConnection {
  let cursor = revisionSchema.parse(afterRevision);
  return fetchSSE(
    `${groupPath(apiBase, groupId)}/events/stream?afterRevision=${cursor}`,
    {
      ...options,
      maxFrameBytes: CLI_SESSION_GROUP_EVENT_LIMITS.frameBytes,
      onOpen: callbacks.onOpen,
      onError: callbacks.onError,
      onTerminal: callbacks.onTerminal,
      stopOnError: (error) =>
        error instanceof CliSessionGroupProtocolError ||
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
          checkpoint.id !== cliSessionGroupStreamCursor(groupId, cursor)
        )
          throw new CliSessionGroupProtocolError(
            'Invalid session group checkpoint.',
          );
      },
      onMessage(message) {
        if (message.event === 'unavailable')
          throw new CliSessionGroupProtocolError(
            'Session group stream unavailable.',
          );
        if (message.event !== 'cli-group-events') return false;
        if (
          new TextEncoder().encode(message.data).byteLength >
          CLI_SESSION_GROUP_EVENT_LIMITS.pageBytes
        )
          throw new CliSessionGroupProtocolError(
            'Session group event page too large.',
          );
        let value: unknown;
        try {
          value = JSON.parse(message.data);
        } catch {
          throw new CliSessionGroupProtocolError(
            'Invalid session group event JSON.',
          );
        }
        const page = eventPage(value, groupId);
        if (
          message.id !==
            cliSessionGroupStreamCursor(groupId, page.nextRevision) ||
          page.nextRevision < cursor ||
          page.afterRevision > cursor
        )
          throw new CliSessionGroupProtocolError(
            'Invalid session group stream cursor.',
          );
        if (page.nextRevision === cursor && page.events.length > 0)
          return false;
        if (page.nextRevision > cursor && page.afterRevision !== cursor)
          throw new CliSessionGroupProtocolError('Session group event gap.');
        callbacks.onPage(page);
        cursor = page.nextRevision;
        return true;
      },
    },
  );
}
async function command(
  url: string,
  input: unknown,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 262_144)
    throw new Error('Session group request exceeds 256 KiB.');
  const response = await mutateJson(
    url,
    'POST',
    { ...options, maxResponseBytes: 262_144 },
    input,
  );
  return viewSchema.parse(await readEnvelopeOrThrow<unknown>(response));
}
export function createCliSessionGroup(
  apiBase: string,
  input: CliSessionGroupCreateInput,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  return command(root(apiBase), parseCliSessionGroupInput(input), options);
}

/** Saves a preset-derived group; engine startup remains an explicit run command. */
export function createEnsembleCliSessionGroup(
  apiBase: string,
  input: EnsembleCliSessionGroupInput,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  return command(
    `${root(apiBase)}/from-ensemble`,
    parseEnsembleCliSessionGroupInput(input),
    options,
  );
}
export async function getCliSessionGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  return viewSchema.parse(
    await readEnvelopeOrThrow<unknown>(
      await getJson(groupPath(apiBase, groupId), {
        ...options,
        maxResponseBytes: 262_144,
      }),
    ),
  );
}
/** Supervision follows the server deadline; aborting requests interruption, not proven termination. */
export function runCliSessionGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  return command(
    `${groupPath(apiBase, groupId)}/run`,
    {},
    { timeoutMs: null, ...options },
  );
}
export function parseCliSessionGroupSyncInput(input: unknown): {
  operationId: string;
  runId: string;
  content: string;
  deadlineAt: number;
} {
  const parsed = z
    .object({
      operationId: seatId,
      runId: seatId,
      content: z
        .string()
        .min(1)
        .max(128 * 1024),
      deadlineAt: z.number().int().positive().safe(),
    })
    .strict()
    .parse(input);
  if (new TextEncoder().encode(parsed.content).length > 128 * 1024)
    throw new Error('group_invalid');
  return parsed;
}
export async function syncCliSessionGroup(
  apiBase: string,
  groupId: string,
  input: ReturnType<typeof parseCliSessionGroupSyncInput>,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  const sent = parseCliSessionGroupSyncInput(input);
  const result = await command(`${groupPath(apiBase, groupId)}/sync`, sent, {
    timeoutMs: null,
    ...options,
  });
  if (
    result.groupId !== groupId ||
    result.contextSync?.operationId !== sent.operationId ||
    result.contextSync.runId !== sent.runId
  )
    throw new CliSessionGroupProtocolError(
      'Unexpected session group sync operation.',
    );
  return result;
}
export function cancelCliSessionGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  return command(`${groupPath(apiBase, groupId)}/cancel`, {}, options);
}

export async function listCliSessionGroups(
  apiBase: string,
  input: { afterGroupId?: string } = {},
  options?: ClientRequestOptions,
): Promise<CliSessionGroupListPage> {
  const suffix =
    input.afterGroupId === undefined
      ? ''
      : `?afterGroupId=${encodeURIComponent(seatId.parse(input.afterGroupId))}`;
  const response = await getJson(`${root(apiBase)}${suffix}`, {
    ...options,
    maxResponseBytes: 262_144,
  });
  return z
    .object({
      groups: z.array(viewSchema).max(16),
      nextGroupId: seatId.nullable(),
      hasMore: z.boolean(),
    })
    .strict()
    .parse(await readEnvelopeOrThrow<unknown>(response));
}
