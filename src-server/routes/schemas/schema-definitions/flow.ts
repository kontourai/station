import { z } from 'zod/v3';

// Flow runs (gate engine) — request bodies for /api/projects/:slug/flow

const safeRunIdSchema = z
  .string()
  .min(1)
  .regex(
    /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/,
    'runId may only contain letters, digits, ".", "_" and "-"',
  );

export const flowRunStartSchema = z.object({
  /** Definition id (resolved under .flow/definitions/) or a path relative to the workspace. */
  definition: z.string().min(1),
  runId: safeRunIdSchema.optional(),
  params: z.record(z.string(), z.any()).optional(),
});

/**
 * `trustArtifact`, `claimType`, `claimStatus`, and `claimSubject` are gone
 * (archive#290): they addressed Flow's pre-1.3 claim-record evidence model, and Flow
 * has ignored them ever since. Accepting them made the API look like it
 * supported a claim shape it silently discarded.
 */
export const flowEvidenceAttachSchema = z.object({
  gate: z.string().min(1),
  /** Evidence file path, resolved relative to the project workspace. */
  file: z.string().min(1),
  kind: z.string().optional(),
  status: z.string().optional(),
  producer: z.string().optional(),
  routeReason: z.string().optional(),
  expectationIds: z.array(z.string()).optional(),
  supersede: z.union([z.string(), z.array(z.string())]).optional(),
});

export const flowCommandEvidenceSchema = z.object({
  gate: z.string().min(1),
  /** Command line, executed through the platform shell in the project workspace. */
  command: z.string().min(1),
  /** Claim type asserted over the command output (e.g. quality.static-checks). */
  claimType: z.string().min(1),
  producer: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  expectationIds: z.array(z.string()).optional(),
  supersede: z.union([z.string(), z.array(z.string())]).optional(),
  /** Kill the command after this long (default 10 minutes, max 30). */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60 * 1000)
    .optional(),
});

export const flowReadinessEvidenceSchema = z.object({
  /** Explicit gate id; otherwise resolved from the run's definition. */
  gate: z.string().min(1).optional(),
  /** Force a fresh veritas readiness run (default true). */
  refresh: z.boolean().optional(),
});

export const flowEvaluateSchema = z.object({
  gate: z.string().min(1).optional(),
});

export const flowExceptionSchema = z.object({
  gate: z.string().min(1),
  reason: z.string().min(1),
  authority: z.string().min(1),
});

export const surveyFlowReviewDiscoverSchema = z.object({
  gate: z.string().min(1),
  expectedRunHead: z.string().regex(/^[a-f0-9]{64}$/i),
  reviewExpectationIds: z.array(z.string().min(1)).min(1),
});

export const surveyFlowReviewContinueSchema = z.object({
  gate: z.string().min(1),
  expectedRunHead: z.string().regex(/^[a-f0-9]{64}$/i),
  reviewSessionRef: z.string().min(1),
  resume: z
    .object({
      reason: z.string().min(1),
      authority: z.object({
        kind: z.enum(['user_request', 'operator_request']),
        actor: z.string().min(1),
        request_ref: z.string().min(1),
        requested_at: z.string().min(1),
      }),
      at: z.string().min(1).optional(),
    })
    .passthrough(),
  now: z.string().min(1).optional(),
});
