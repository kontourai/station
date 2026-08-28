import { validateSchedule } from '@kontourai/ephemeris';
import { z } from 'zod/v3';
import { CHAT_INPUT_MAX_CHARS } from '../../../../src-shared/chat-input-limits.js';

// archive#2829: a scheduled job's prompt starts an agent turn on a cadence,
// unattended. Bound it at SCHEDULE time — the validate() boundary of the
// add/edit routes — so the refusal reaches the person creating the job, not
// a fire-time failure nobody is watching. Both the create and edit forms
// carry the same concept (the job's prompt), so both derive from the same
// declared authored-text maximum the composer and chat routes use.
const jobPrompt = z.string().min(1).max(CHAT_INPUT_MAX_CHARS);

const optionalCron = z
  .string()
  .optional()
  .refine(
    (value) =>
      !value || validateSchedule({ kind: 'cron', expr: value }) === null,
    { message: 'Invalid cron expression' },
  );

const scheduleSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('cron'),
      expr: z.string().min(1),
      timezone: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal('every'),
      everyMs: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('at'),
      timeMs: z.number().finite(),
      deleteAfterRun: z.boolean().optional(),
    }),
  ])
  .superRefine((schedule, context) => {
    const error = validateSchedule(schedule);
    if (error !== null) context.addIssue({ code: 'custom', message: error });
  });

const monitorSchema = z
  .object({
    kind: z.literal('github-pull-request'),
    objective: z.literal('review-ready'),
    target: z.string().url().max(2048),
    projectId: z.string().min(1).max(256),
    agentId: z.string().min(1).max(256),
    credentialSecretBinding: z.string().min(1).max(256).optional(),
    budget: z
      .object({
        maxTurns: z.number().int().positive().max(20).optional(),
        maxTokens: z.number().int().positive().max(1_000_000).optional(),
        maxRuntimeMs: z.number().int().positive().max(7_200_000).optional(),
        maxWallRuntimeMs: z.number().int().positive().max(7_200_000).optional(),
        maxActive: z.number().int().positive().max(4).optional(),
        maxConcurrency: z.number().int().positive().max(4).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function rejectAmbiguousSchedule(
  value: { cron?: string; schedule?: unknown },
  context: z.RefinementCtx,
) {
  if (value.cron !== undefined && value.schedule !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Use either cron or schedule, not both',
    });
  }
}

export const addJobSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'lowercase alphanumeric + hyphens only'),
    cron: optionalCron,
    schedule: scheduleSchema.optional(),
    prompt: jobPrompt,
    agent: z.string().optional(),
    provider: z.string().optional(),
    notifyStart: z.boolean().optional(),
    trustAllTools: z.boolean().optional(),
    retryCount: z.number().int().min(0).max(10).optional(),
    retryDelaySecs: z.number().int().min(0).max(3600).optional(),
    monitor: monitorSchema.optional(),
  })
  .superRefine(rejectAmbiguousSchedule)
  .superRefine((value, context) => {
    if (!value.monitor) return;
    if (value.provider && value.provider !== 'built-in') {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'External monitor requires the built-in scheduler provider',
      });
    }
    if (!value.monitor.agentId?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['monitor', 'agentId'],
        message: 'External monitor requires a Task Agent',
      });
    }
    if (value.trustAllTools) {
      context.addIssue({
        code: 'custom',
        path: ['trustAllTools'],
        message: 'External monitor cannot enable generic tool trust',
      });
    }
    if ((value.retryCount ?? 0) !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['retryCount'],
        message: 'External monitor cannot use generic retries',
      });
    }
    if (value.notifyStart)
      context.addIssue({
        code: 'custom',
        path: ['notifyStart'],
        message: 'External monitor cannot use generic start notifications',
      });
  });

export const editJobSchema = z
  .object({
    cron: optionalCron,
    schedule: scheduleSchema.optional(),
    // Same concept as addJobSchema.prompt — the job's prompt, edited — so
    // the same bound; optional stays optional (omitting it leaves the
    // prompt untouched).
    prompt: jobPrompt.optional(),
    agent: z.string().optional(),
    enabled: z.boolean().optional(),
    notifyStart: z.boolean().optional(),
    trustAllTools: z.boolean().optional(),
    retryCount: z.number().int().min(0).max(10).optional(),
    retryDelaySecs: z.number().int().min(0).max(3600).optional(),
    // Unlike creation, an edit has a meaningful explicit absence: `null`
    // removes the monitor. Omitting the key leaves it unchanged.
    monitor: monitorSchema.nullable().optional(),
  })
  .superRefine(rejectAmbiguousSchedule);

// fallow-ignore-next-line unused-export
export const schedulerOpenSchema = z.object({
  source: z.string().optional(),
  providerId: z.string().optional(),
  runId: z.string().optional(),
  artifactId: z.string().min(1),
  kind: z.string().optional(),
});
