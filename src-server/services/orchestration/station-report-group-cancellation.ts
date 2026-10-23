import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@kontourai/relay';
import { z } from 'zod/v3';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const reportInterruptResultSchema = z
  .object({
    outcome: z.enum([
      'cooperative',
      'forced',
      'termination-unconfirmed',
      'turn-completed',
      'pending-turn-start',
      'no-active-turn',
    ]),
    threadId: id,
    turnId: id.optional(),
  })
  .strict();
const intentSchema = z
  .object({
    groupId: id,
    operationId: id,
    hostId: id,
    principalId: id,
    admissionSignature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    seatId: id,
    taskId: id,
    clientTurnId: id,
    sessionId: id,
    turnId: id,
  })
  .strict();
export const reportInterruptRecordSchema = z
  .object({
    intent: intentSchema,
    acknowledgement: reportInterruptResultSchema.nullable(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict()
  .superRefine((record, context) => {
    const ack = record.acknowledgement;
    if (
      record.intent.taskId !== record.intent.sessionId ||
      (ack &&
        (ack.threadId !== record.intent.sessionId ||
          (ack.turnId !== undefined && ack.turnId !== record.intent.turnId) ||
          (!['pending-turn-start', 'no-active-turn'].includes(ack.outcome) &&
            ack.turnId !== record.intent.turnId)))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Report interrupt identity mismatch',
      });
  });
export const reportInterruptLedgerSchema = z
  .object({
    version: z.literal(1),
    groupId: id,
    entries: z.array(reportInterruptRecordSchema).min(1).max(16),
  })
  .strict()
  .superRefine((ledger, context) => {
    if (
      ledger.entries.some((entry) => entry.intent.groupId !== ledger.groupId) ||
      new Set(ledger.entries.map((entry) => entry.intent.seatId)).size !==
        ledger.entries.length
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Report interrupt ledger mismatch',
      });
  });
export type ReportInterruptRecord = z.infer<typeof reportInterruptRecordSchema>;
export type ReportInterruptIntent = z.infer<typeof intentSchema>;
const DOMAIN = 'station.report-group.interrupt.v1';
export function signReportInterrupt(
  intent: ReportInterruptIntent,
  acknowledgement: ReportInterruptRecord['acknowledgement'],
  environment: EnvironmentSecurityService,
): ReportInterruptRecord {
  const data = { intent, acknowledgement };
  return reportInterruptRecordSchema.parse({
    ...data,
    signature: environment.signRevisionEvidenceAuthorityBinding(
      canonicalJson([DOMAIN, data]),
    ),
  });
}
export function verifyReportInterrupt(
  record: ReportInterruptRecord,
  environment: EnvironmentSecurityService,
): boolean {
  const expected = Buffer.from(
    signReportInterrupt(record.intent, record.acknowledgement, environment)
      .signature,
    'base64url',
  );
  const actual = Buffer.from(record.signature, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function reportInterruptReference(record: ReportInterruptRecord) {
  return {
    domain: DOMAIN,
    id: `cancel:${createHash('sha256').update(canonicalJson(record.intent)).digest('hex')}`,
    digest: `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`,
  };
}
