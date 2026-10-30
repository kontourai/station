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
 */

import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_EXECUTION_LIMITS,
  AUTOMATION_SCHEMA_VERSION,
  type AutomationEvent,
  type AutomationRefusalReason,
  type AutomationSourceKind,
} from '@kontourai/station-contracts/automation';

export const WORKFLOW_RUN_COMPLETED = 'github.workflow_run.completed' as const;

const HEAD_SHA = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/;
/** C0, DEL and C1 controls: a matcher value is a single printable line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class names the refused characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** GitHub's REST timestamps are second-precision UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
const GITHUB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

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

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A bounded, single-line string, or undefined. */
function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AUTOMATION_EXECUTION_LIMITS.maxMatcherValueLength &&
    !CONTROL.test(value)
    ? value
    : undefined;
}

/** GitHub ids and attempts are positive integers; carried as decimal strings. */
function decimalId(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    return undefined;
  const text = String(value);
  return POSITIVE_INTEGER.test(text) ? text : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !GITHUB_TIMESTAMP.test(value))
    return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function workflowRunSemanticKey(id: string, attempt: string): string {
  return `workflow_run:${id}:${attempt}:completed`;
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
  const value = record(run);
  const id = decimalId(value?.id);
  const attempt = decimalId(value?.run_attempt);
  const semanticKey = workflowRunSemanticKey(
    id ?? 'invalid',
    attempt ?? 'invalid',
  );
  const updatedAtMs = parseTimestamp(value?.updated_at);
  const refuse = (reason: AutomationRefusalReason) =>
    ({
      kind: 'refused',
      reason,
      semanticKey,
      ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
    }) as const;
  if (!value || !id || !attempt || updatedAtMs === undefined)
    return refuse('malformed_request');
  // The poll lists completed runs only; anything else is not this event type.
  if (value.status !== 'completed') return refuse('malformed_request');
  const repository = boundedText(record(value.repository)?.full_name);
  if (!repository) return refuse('malformed_request');
  if (repository !== context.source.repository)
    return refuse('wrong_repository');
  const conclusion = boundedText(value.conclusion);
  const event = boundedText(value.event);
  const workflowPath = boundedText(value.path);
  const headSha =
    typeof value.head_sha === 'string' && HEAD_SHA.test(value.head_sha)
      ? value.head_sha
      : undefined;
  // Exact, never a prefix or a parse: the URL is handed to an agent later,
  // so it must point at this run in this repository and nowhere else.
  const htmlUrl =
    value.html_url === `https://github.com/${repository}/actions/runs/${id}`
      ? value.html_url
      : undefined;
  if (!conclusion || !event || !workflowPath || !headSha || !htmlUrl)
    return refuse('malformed_request');
  // A branch-less run (some event kinds) or a deleted fork carries null here.
  // Absent is honest: a matcher naming the field then cannot match.
  const headBranch =
    value.head_branch === null ? undefined : boundedText(value.head_branch);
  if (value.head_branch !== null && headBranch === undefined)
    return refuse('malformed_request');
  const headRepositoryValue = value.head_repository;
  const headRepository =
    headRepositoryValue === null
      ? undefined
      : boundedText(record(headRepositoryValue)?.full_name);
  if (headRepositoryValue !== null && headRepository === undefined)
    return refuse('malformed_request');
  const maxAge =
    context.maxEventAgeMs ?? AUTOMATION_EXECUTION_LIMITS.maxEventAgeMs;
  if (updatedAtMs < context.receivedAt - maxAge) return refuse('stale_event');
  if (updatedAtMs > context.receivedAt) return refuse('malformed_request');

  const fields: Record<string, string> = {
    repository,
    'workflow.path': workflowPath,
    'run.id': id,
    'run.run_attempt': attempt,
    'run.event': event,
    'run.conclusion': conclusion,
    'run.head_sha': headSha,
    'run.html_url': htmlUrl,
  };
  if (headBranch !== undefined) fields['run.head_branch'] = headBranch;
  if (headRepository !== undefined)
    fields['run.head_repository'] = headRepository;
  return {
    kind: 'event',
    updatedAtMs,
    event: {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      eventId: randomUUID(),
      sourceId: context.source.id,
      sourceKind: context.source.kind,
      type: WORKFLOW_RUN_COMPLETED,
      semanticKey,
      occurredAt: new Date(updatedAtMs).toISOString(),
      receivedAt: new Date(context.receivedAt).toISOString(),
      fields,
    },
  };
}
