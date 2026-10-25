import { createHash } from 'node:crypto';
import { canonicalJson } from '@kontourai/relay';
import {
  assertReportGroupContinuation,
  REPORT_GROUP_CONTINUATION_LIMITS,
  type ReportGroupInput,
} from '@kontourai/station-contracts/report-group';
import { z } from 'zod/v3';

export class StationReportPreparationUnavailable extends Error {
  readonly code = 'group_preparation_unavailable';
  constructor() {
    super('Report group preparation is unavailable.');
  }
}

function refuse(): never {
  throw new StationReportPreparationUnavailable();
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
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
    budget: z
      .object({
        inputTokens: integer,
        outputTokens: integer,
        costMicros: integer,
      })
      .strict(),
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
export type StationReportGroupInput = ReportGroupInput;
export function parseStationReportGroupInput(
  sent: unknown,
): StationReportGroupInput {
  const input = inputSchema.parse(structuredClone(sent));
  assertReportGroupContinuation(input);
  if (Buffer.byteLength(canonicalJson(input)) > 256 * 1024) refuse();
  if (input.flow) {
    const seats = input.members.map((member) => member.seatId);
    const bindings = Object.entries(input.flow.steps);
    if (
      bindings.length !== seats.length ||
      bindings.some(([seat]) => !seats.includes(seat)) ||
      new Set(bindings.map(([, step]) => step)).size !== seats.length
    )
      refuse();
  }
  return input;
}

export const REPORT_INTENT_DOMAIN = 'station.report-intent.v1' as const;
export function encodeReportIntent(groupId: string, sent: ReportGroupInput) {
  id.parse(groupId);
  const intent = parseStationReportGroupInput(sent);
  const record = { version: 1 as const, groupId, intent };
  const serialized = canonicalJson(record);
  const digest = createHash('sha256').update(serialized).digest('hex');
  return {
    record,
    serialized,
    reference: {
      id: digest,
      domain: REPORT_INTENT_DOMAIN,
      digest: `sha256:${digest}`,
    },
  };
}
