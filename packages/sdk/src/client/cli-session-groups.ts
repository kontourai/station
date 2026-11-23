import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  CliSessionGroupCreateInput,
  CliSessionGroupListPage,
  CliSessionGroupSync,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import { z } from 'zod/v3';
import { hasCapability } from './capability.js';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './http';
import { fetchPublicStationCapabilities } from './publicStationCapabilities.js';

export type {
  CliSessionGroupCreateInput,
  CliSessionGroupListPage,
  CliSessionGroupSync,
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
            prompt: z.string().trim().min(1).max(200_000),
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
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const contextSyncSchema: z.ZodType<CliSessionGroupSync> = z
  .object({
    operationId: seatId,
    runId: seatId,
    contentHash: sha256,
    timestamp: z.string().datetime(),
    status: z.enum(['syncing', 'acknowledged', 'incomplete']),
    members: z
      .array(
        z
          .object({
            seatId,
            status: z.enum(['pending', 'acknowledged', 'failed', 'unknown']),
            attempts: z.number().int().min(0).max(2),
            timestamp: z.string().datetime().optional(),
            turnId: text.optional(),
            terminalEventId: text.optional(),
            nativeIdentityHash: sha256.optional(),
            toolCalls: z.number().int().min(0).max(1_000_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

const syncInputSchema = z
  .object({
    operationId: seatId,
    runId: seatId,
    content: z
      .string()
      .min(1)
      .refine(
        (content) =>
          content.trim().length > 0 &&
          new TextEncoder().encode(content).byteLength <= 128 * 1024,
        'Sync content must be nonempty and fit within 128 KiB of UTF-8.',
      ),
    deadlineAt: z.number().int().positive().safe(),
  })
  .strict();

const viewSchema: z.ZodType<CliSessionGroupView> = z
  .object({
    version: z.literal('station.cli-session-group/v1'),
    groupId: seatId,
    revision: z.number().int().nonnegative(),
    supervision: z.enum(['active', 'not-running']),
    cancelled: z.boolean(),
    deadlineAt: z.number().int().positive(),
    maxConcurrent: z.number().int().min(1).max(32),
    maxDispatches: z.number().int().min(0).max(32),
    admissionClosed: z.literal('dispatch-limit-exhausted').optional(),
    dispatchCount: z.number().int().min(0).max(32),
    contextSync: contextSyncSchema.optional(),
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

/** Local named Agents, with an expected engine and explicit operation identity. */
export function parseCliSessionGroupInput(
  value: unknown,
): CliSessionGroupCreateInput {
  return inputSchema.parse(value);
}
async function requireCliSessionGroups(apiBase: string): Promise<void> {
  const handshake = await fetchPublicStationCapabilities(apiBase);
  if (!handshake)
    throw new Error('Station capabilities are unavailable. Try again.');
  if (!hasCapability(handshake, 'cliSessionGroups'))
    throw new Error(
      'This Station does not support the Session groups preview. Use an updated personal Station.',
    );
}

const root = (apiBase: string) => `${apiBase}/api/orchestration/session-groups`;
const groupPath = (apiBase: string, groupId: string) =>
  `${root(apiBase)}/${encodeURIComponent(seatId.parse(groupId))}`;
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
export async function createCliSessionGroup(
  apiBase: string,
  input: CliSessionGroupCreateInput,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  const parsed = parseCliSessionGroupInput(input);
  await requireCliSessionGroups(apiBase);
  return command(root(apiBase), parsed, options);
}
export async function getCliSessionGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions & { includeContextSync?: boolean },
): Promise<CliSessionGroupView> {
  await requireCliSessionGroups(apiBase);
  const { includeContextSync, ...requestOptions } = options ?? {};
  const path = groupPath(apiBase, groupId);
  const url = includeContextSync ? `${path}?includeContextSync=1` : path;
  return viewSchema.parse(
    await readEnvelopeOrThrow<unknown>(
      await getJson(url, {
        ...requestOptions,
        maxResponseBytes: 262_144,
      }),
    ),
  );
}
/** Supervision follows the server deadline; aborting requests interruption, not proven termination. */
export async function runCliSessionGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  await requireCliSessionGroups(apiBase);
  return command(
    `${groupPath(apiBase, groupId)}/run`,
    {},
    { timeoutMs: null, ...options },
  );
}
export async function cancelCliSessionGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  await requireCliSessionGroups(apiBase);
  return command(`${groupPath(apiBase, groupId)}/cancel`, {}, options);
}

/** Validate a local Session-group sync plan before sending it. */
export function parseCliSessionGroupSyncInput(input: unknown) {
  return syncInputSchema.parse(input);
}

/** Send bounded folded context to the retained member Sessions. */
export async function syncCliSessionGroup(
  apiBase: string,
  groupId: string,
  input: z.infer<typeof syncInputSchema>,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  const sent = parseCliSessionGroupSyncInput(input);
  await requireCliSessionGroups(apiBase);
  const result = await command(`${groupPath(apiBase, groupId)}/sync`, sent, {
    timeoutMs: null,
    ...options,
  });
  if (
    result.groupId !== groupId ||
    result.contextSync?.operationId !== sent.operationId ||
    result.contextSync.runId !== sent.runId
  )
    throw new Error('Unexpected Session-group sync receipt.');
  return result;
}

/** Read one page of groups created with the selected Station credential. */
export async function listCliSessionGroups(
  apiBase: string,
  input: { afterGroupId?: string; includeContextSync?: boolean } = {},
  options?: ClientRequestOptions,
): Promise<CliSessionGroupListPage> {
  const query = new URLSearchParams();
  if (input.afterGroupId !== undefined)
    query.set('afterGroupId', seatId.parse(input.afterGroupId));
  if (input.includeContextSync) query.set('includeContextSync', '1');
  const suffix = query.size ? `?${query}` : '';
  await requireCliSessionGroups(apiBase);
  const response = await getJson(`${root(apiBase)}${suffix}`, {
    ...options,
    maxResponseBytes: 262_144,
  });
  if (response.status === 404)
    throw new Error(
      'Session group listing is unavailable. Enable the preview on an updated personal Station.',
    );
  return z
    .object({
      groups: z.array(viewSchema).max(16),
      nextGroupId: seatId.nullable(),
      hasMore: z.boolean(),
    })
    .strict()
    .refine((page) =>
      page.hasMore
        ? page.nextGroupId !== null &&
          page.nextGroupId === page.groups.at(-1)?.groupId
        : page.nextGroupId === null,
    )
    .parse(await readEnvelopeOrThrow<unknown>(response));
}
