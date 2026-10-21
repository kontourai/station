import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  CliSessionGroupCreateInput,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import { z } from 'zod/v3';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './http';

export type {
  CliSessionGroupCreateInput,
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
const viewSchema: z.ZodType<CliSessionGroupView> = z
  .object({
    version: z.literal('station.cli-session-group/v1'),
    groupId: seatId,
    revision: z.number().int().nonnegative(),
    supervision: z.enum(['active', 'not-running']),
    cancelled: z.boolean(),
    deadlineAt: z.number().int().positive(),
    maxConcurrent: z.number().int().min(1).max(32),
    dispatchCount: z.number().int().min(0).max(32),
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
export function createCliSessionGroup(
  apiBase: string,
  input: CliSessionGroupCreateInput,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  return command(root(apiBase), parseCliSessionGroupInput(input), options);
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
export function cancelCliSessionGroup(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
): Promise<CliSessionGroupView> {
  return command(`${groupPath(apiBase, groupId)}/cancel`, {}, options);
}
