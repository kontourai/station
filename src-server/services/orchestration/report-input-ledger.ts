import { createHash } from 'node:crypto';
import { canonicalJson } from '@kontourai/relay';
import type { InputRequestResponse } from '@kontourai/station-contracts/input-request';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  readInputRequestForm,
  readInputRequestResponse,
  validateInputRequestContent,
} from '@kontourai/station-shared/input-request';
import { z } from 'zod/v3';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const reference = z
  .object({ id, domain: z.string().min(1).max(128), digest })
  .strict();
export const reportInputBindingSchema = z
  .object({
    groupId: id,
    rootId: id,
    executionId: id,
    authority: reference
      .extend({ authority_epoch: z.number().int().nonnegative().safe() })
      .omit({ domain: true })
      .strict(),
    envelope: z
      .object({ id, generation: z.number().int().nonnegative().safe(), digest })
      .strict(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().safe(),
        outputTokens: z.number().int().nonnegative().safe(),
        costMicros: z.number().int().nonnegative().safe(),
      })
      .strict(),
    seatId: id,
    invocationId: id,
    providerToolCallId: z.string().min(1).max(128),
    providerEvidence: reference
      .extend({ domain: z.literal('station.provider-evidence') })
      .strict(),
    threadId: id,
    turnId: id,
    recipient: z
      .object({
        hostId: id,
        recipientId: id,
        generation: z.number().int().positive().safe(),
        executionId: id,
        sessionReceipt: reference
          .extend({ domain: z.literal('station.reserved-session.v1') })
          .strict(),
      })
      .strict(),
    question: z
      .string()
      .min(1)
      .max(512)
      .refine((s) => !!s.trim() && Buffer.byteLength(s) <= 2048),
  })
  .strict();
export type ReportInputBinding = z.infer<typeof reportInputBindingSchema>;
export const reportInputRecordSchema = z
  .object({
    version: z.literal(1),
    binding: reportInputBindingSchema,
    physicalSends: z.number().int().min(0).max(2),
    question: z
      .object({
        eventId: id,
        requestId: id,
        form: z.unknown(),
        formDigest: digest,
      })
      .strict()
      .optional(),
    answer: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const form = record.question && readInputRequestForm(record.question.form);
    const result =
      record.result === undefined
        ? undefined
        : readInputRequestResponse(record.result);
    const answer =
      record.answer === undefined
        ? undefined
        : readInputRequestResponse(record.answer);
    if (
      (record.question &&
        (!form || reportInputDigest(form) !== record.question.formDigest)) ||
      (record.question && record.physicalSends < 1) ||
      (record.answer !== undefined && (!record.question || !answer)) ||
      (record.physicalSends === 2 && record.answer === undefined) ||
      (record.result !== undefined &&
        (record.physicalSends !== 2 ||
          !answer ||
          !result ||
          canonicalJson(answer) !== canonicalJson(result)))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid input phase joins',
      });
    if (form && answer?.action === 'accept') {
      try {
        validateInputRequestContent(form, answer.content);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid retained input answer',
        });
      }
    }
  });
export type ReportInputRecord = z.infer<typeof reportInputRecordSchema>;
export interface ReportInputStore {
  transact<T>(
    key: string,
    update: (previous: ReportInputRecord | null) => {
      record: ReportInputRecord;
      result: T;
    },
  ): Promise<T>;
}
export function reportInputDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
export function reportInputKey(
  binding: Pick<ReportInputBinding, 'groupId' | 'invocationId'>,
): string {
  return createHash('sha256')
    .update(canonicalJson([binding.groupId, binding.invocationId]))
    .digest('hex');
}
function requireInput(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
export function assertReportInputTransition(
  previous: ReportInputRecord | null,
  next: ReportInputRecord,
): void {
  if (!previous) {
    requireInput(
      next.physicalSends === 0 &&
        !next.question &&
        next.answer === undefined &&
        next.result === undefined,
      'report_input_initial_state',
    );
    return;
  }
  const equal = (left: unknown, right: unknown) =>
    left === undefined || right === undefined
      ? left === right
      : canonicalJson(left) === canonicalJson(right);
  const changed = (
    ['physicalSends', 'question', 'answer', 'result'] as const
  ).filter((field) => !equal(previous[field], next[field]));
  requireInput(
    equal(previous.binding, next.binding) && changed.length === 1,
    'report_input_transition_refused',
  );
  switch (changed[0]) {
    case 'physicalSends':
      requireInput(
        next.physicalSends === previous.physicalSends + 1 &&
          previous.physicalSends < 2 &&
          (previous.physicalSends === 0 || previous.answer !== undefined),
        'report_input_transition_refused',
      );
      break;
    case 'question':
      requireInput(
        previous.physicalSends === 1 &&
          !previous.question &&
          !!next.question &&
          previous.answer === undefined,
        'report_input_transition_refused',
      );
      break;
    case 'answer':
      requireInput(
        previous.physicalSends === 1 &&
          !!previous.question &&
          previous.answer === undefined &&
          next.answer !== undefined,
        'report_input_transition_refused',
      );
      break;
    case 'result':
      requireInput(
        previous.physicalSends === 2 &&
          previous.result === undefined &&
          next.result !== undefined &&
          equal(previous.answer, next.result),
        'report_input_transition_refused',
      );
      break;
  }
}

/** One operation per paid invocation; durable state cannot recreate its live claim. */
export class ReportInputLedger {
  private readonly claims = new Map<string, ReportInputRecord>();
  constructor(private readonly store: ReportInputStore) {}
  async begin(value: ReportInputBinding): Promise<void> {
    const binding = reportInputBindingSchema.parse(structuredClone(value));
    const key = reportInputKey(binding);
    const record: ReportInputRecord = { version: 1, binding, physicalSends: 0 };
    await this.store.transact(key, (previous) => {
      requireInput(!previous, 'report_input_already_claimed');
      return { record, result: undefined };
    });
    this.claims.set(key, structuredClone(record));
  }

  private async mutate<T>(
    binding: ReportInputBinding,
    update: (record: ReportInputRecord) => T,
  ): Promise<T> {
    const expected = reportInputBindingSchema.parse(structuredClone(binding));
    const key = reportInputKey(expected);
    const captured = this.claims.get(key);
    requireInput(captured, 'report_input_no_live_claim');
    const changed = await this.store.transact(key, (record) => {
      requireInput(
        record &&
          canonicalJson(record) === canonicalJson(captured) &&
          canonicalJson(record.binding) === canonicalJson(expected),
        'report_input_binding_changed',
      );
      requireInput(record.result === undefined, 'report_input_finished');
      const result = update(record);
      return { record, result: { record: structuredClone(record), result } };
    });
    this.claims.set(key, changed.record);
    return changed.result;
  }

  async consumeSend(
    binding: ReportInputBinding,
    answer?: InputRequestResponse,
  ): Promise<number> {
    return this.mutate(binding, (record) => {
      requireInput(
        record.physicalSends < 2 &&
          (record.physicalSends === 0
            ? answer === undefined
            : record.answer !== undefined &&
              answer !== undefined &&
              canonicalJson(record.answer) === canonicalJson(answer)),
        'report_input_send_limit',
      );
      return ++record.physicalSends;
    });
  }
  async bindQuestion(
    binding: ReportInputBinding,
    event: Extract<CanonicalRuntimeEvent, { method: 'request.opened' }>,
  ): Promise<void> {
    const captured = structuredClone(event);
    const form = readInputRequestForm(captured.payload?.inputRequest);
    requireInput(
      captured.provider === 'station-agent' &&
        captured.threadId === binding.threadId &&
        captured.turnId === binding.turnId &&
        captured.requestType === 'approval' &&
        form?.source === 'mcp:station-report-input' &&
        form.message === binding.question,
      'report_input_question_binding',
    );
    await this.mutate(binding, (record) => {
      requireInput(
        record.physicalSends === 1 && !record.question,
        'report_input_question_limit',
      );
      record.question = {
        eventId: captured.eventId,
        requestId: captured.requestId,
        form,
        formDigest: reportInputDigest(form),
      };
    });
  }
  async retainAnswer(
    binding: ReportInputBinding,
    value: InputRequestResponse,
  ): Promise<void> {
    const answer = readInputRequestResponse(structuredClone(value));
    requireInput(answer, 'report_input_answer_invalid');
    await this.mutate(binding, (record) => {
      const form =
        record.question && readInputRequestForm(record.question.form);
      requireInput(
        record.physicalSends === 1 && form && record.answer === undefined,
        'report_input_answer_refused',
      );
      record.answer =
        answer.action === 'accept'
          ? {
              action: 'accept',
              content: validateInputRequestContent(form, answer.content),
            }
          : answer;
    });
  }
  async finish(binding: ReportInputBinding, result: InputRequestResponse) {
    return this.mutate(binding, (record) => {
      requireInput(
        record.physicalSends === 2 &&
          canonicalJson(record.answer) === canonicalJson(result),
        'report_input_result_mismatch',
      );
      record.result = structuredClone(result);
      return {
        id: reportInputKey(binding),
        domain: 'station.report-input.v1' as const,
        digest: reportInputDigest(record),
      };
    });
  }
}
