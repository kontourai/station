/**
 * Normalizes one GitHub `workflow_run` REST object into an
 * {@link AutomationEvent} of type `github.workflow_run.completed`
 * (epic kontourai/station#3439, design section 4).
 *
 * Only the fields in `AUTOMATION_EVENT_FIELDS` are copied, each validated
 * and bounded. Actor-supplied free text (`display_title`, `name`,
 * `head_commit.message`, actor logins) is never read. Anything the
 * normalizer cannot vouch for is refused with a closed reason rather than
 * carried partially: a refused run never reaches the matcher.
 *
 * The same normalizer serves the poll source today and the push source
 * later; the semantic key `workflow_run:<id>:<run_attempt>:completed` is the
 * same for both, so a run seen through either is one event.
 *
 * The checks themselves are Telltale's (`normalizeGitHubWorkflowRun` in
 * `@kontourai/telltale`); this module maps its observation onto Station's
 * Automation event.
 */

import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_EXECUTION_LIMITS,
  AUTOMATION_SCHEMA_VERSION,
  type AutomationEvent,
  type AutomationRefusalReason,
  type AutomationSourceKind,
} from '@kontourai/station-contracts/automation';
import {
  type GitHubRunNormalization,
  normalizeGitHubWorkflowRun as normalizeRun,
} from '@kontourai/telltale';

export const WORKFLOW_RUN_COMPLETED = 'github.workflow_run.completed' as const;

export type WorkflowRunNormalization =
  | Readonly<{ kind: 'event'; event: AutomationEvent; updatedAtMs: number }>
  | Readonly<{
      kind: 'refused';
      reason: AutomationRefusalReason;
      /** Best-effort identity for the ledger row; never trusted for dedupe. */
      semanticKey: string;
      /** Parsed `updated_at`, when the run carried a valid one. */
      updatedAtMs?: number;
    }>;

export type WorkflowRunNormalizationContext = Readonly<{
  source: Readonly<{
    id: string;
    kind: AutomationSourceKind;
    repository: string;
  }>;
  receivedAt: number;
  /** Defaults to `AUTOMATION_EXECUTION_LIMITS.maxEventAgeMs`. */
  maxEventAgeMs?: number;
}>;

/**
 * A Telltale workflow-run observation as Station's Automation event: the
 * same allow-listed fields and semantic key, stamped with the source it
 * entered by. A refusal passes through with its closed reason.
 */
export function workflowRunNormalization(
  observation: GitHubRunNormalization,
  context: Omit<WorkflowRunNormalizationContext, 'maxEventAgeMs'>,
): WorkflowRunNormalization {
  if (observation.kind === 'refused') return observation;
  return {
    kind: 'event',
    updatedAtMs: observation.updatedAtMs,
    event: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      eventId: randomUUID(),
      sourceId: context.source.id,
      sourceKind: context.source.kind,
      type: WORKFLOW_RUN_COMPLETED,
      semanticKey: observation.semanticKey,
      occurredAt: new Date(observation.updatedAtMs).toISOString(),
      receivedAt: new Date(context.receivedAt).toISOString(),
      fields: { ...observation.fields },
    },
  };
}

/**
 * Maps one REST `workflow_run` to a normalized event, or a refusal.
 *
 * Refusals, in order: `malformed_request` for a missing or invalid id,
 * attempt, status, conclusion, path, event, SHA, URL or timestamp;
 * `wrong_repository` when `repository.full_name` is not the source's
 * repository; `stale_event` when `updated_at` is older than the freshness
 * bound.
 */
export function normalizeGitHubWorkflowRun(
  run: unknown,
  context: WorkflowRunNormalizationContext,
): WorkflowRunNormalization {
  return workflowRunNormalization(
    normalizeRun(run, {
      repository: context.source.repository,
      receivedAt: context.receivedAt,
      maxEventAgeMs:
        context.maxEventAgeMs ?? AUTOMATION_EXECUTION_LIMITS.maxEventAgeMs,
    }),
    context,
  );
}
