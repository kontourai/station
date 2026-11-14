import { canonicalJson } from '@kontourai/relay';
import { z } from 'zod/v3';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import { reportTerminalWitnessSchema } from './station-report-terminal-witness.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ledgerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const integer = z.number().int().nonnegative().safe();
const dollars = z.number().finite().nonnegative();
const amounts = z
  .object({
    inputTokens: integer,
    outputTokens: integer,
    costMicros: integer.max(1_000_000_000_000),
    costBasis: z.literal('tariff-upper-bound'),
  })
  .strict();
const witnessData = reportTerminalWitnessSchema.shape.data.shape;
export const reportAccountingRecoveryIntentSchema = z
  .object({
    data: z
      .object({
        version: z.literal(1),
        groupId: id,
        seatId: id,
        operationKey: id,
        authorityId: id,
        invocationId: id,
        ownerId: id,
        originEpoch: integer.max(8),
        root: witnessData.root,
        envelope: witnessData.envelope,
        reservationProtocol: z.enum(['legacy-relay', 'retained-tariff-v1']),
        reservation: z
          .object({
            authorizationId: ledgerId,
            invocationId: ledgerId,
            reservationId: ledgerId,
            limits: z
              .object({
                maxAttempts: integer,
                maxTotalTokens: integer.optional(),
                maxCostUsd: dollars.optional(),
              })
              .strict(),
            capacity: z
              .object({
                attempts: z.literal(1),
                maxTokens: integer.optional(),
                maxCostUsd: dollars.optional(),
              })
              .strict(),
          })
          .strict(),
        terminal: reportTerminalWitnessSchema.nullable(),
        wireIntentDigest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .nullable(),
        accounting: amounts.nullable(),
      })
      .strict(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type ReportAccountingRecoveryIntent = z.infer<
  typeof reportAccountingRecoveryIntentSchema
>;
const DOMAIN = 'station.report-accounting-recovery.v1';

export function signReportAccountingRecoveryIntent(
  value: ReportAccountingRecoveryIntent['data'],
  environment: EnvironmentSecurityService,
): ReportAccountingRecoveryIntent {
  const data = reportAccountingRecoveryIntentSchema.shape.data.parse(value);
  return reportAccountingRecoveryIntentSchema.parse({
    data,
    signature: environment.signRevisionEvidenceAuthorityBinding(
      canonicalJson([DOMAIN, data]),
    ),
  });
}
