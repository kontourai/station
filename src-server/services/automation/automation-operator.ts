/**
 * Operator actions that combine the Automation store and ledger (#4513).
 * Routes call these; the ledger owns the transaction.
 */

import type {
  AutomationConfiguration,
  AutomationTaskProjection,
  AutomationEpisodeRecord as PublicEpisodeRecord,
} from '@kontourai/station-contracts/automation';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { sourceGrantsRuleAction } from './automation-config-validation.js';
import {
  automationAuthorityFingerprint,
  automationPolicyFingerprint,
} from './automation-intent.js';
import type {
  AutomationEpisodeRecord,
  AutomationLedger,
  RetryEpisodeOutcome,
} from './automation-ledger.js';

/**
 * `retry-episode`: one more attempt for an exhausted episode, under the
 * rule's current policy. The retry adopts the rule as it is now (not the
 * snapshot the exhausted attempt ran under), and only while that rule is
 * `live`, of the same action kind, on the same repository and granted by an
 * enabled, unrevoked source. Refused (`task-live`) while the Task its
 * failed start created is still live, from `taskStatus` read at the retry.
 */
export function retryAutomationEpisode(input: {
  ledger: Pick<AutomationLedger, 'retryEpisode'>;
  read: () => AutomationConfiguration;
  /** A Task's current status; undefined when it is gone. */
  taskStatus: (taskId: string) => string | undefined;
  ruleId: string;
  episodeId: string;
  now: number;
}): RetryEpisodeOutcome {
  return input.ledger.retryEpisode({
    ruleId: input.ruleId,
    episodeId: input.episodeId,
    now: input.now,
    taskLive: (taskId) => !settledTaskStatus(input.taskStatus(taskId)),
    policy: (latest) => {
      const configuration = input.read();
      const source = configuration.sources.find(
        ({ id }) => id === latest.sourceId,
      );
      const rule = configuration.rules.find(({ id }) => id === latest.ruleId);
      if (
        !source ||
        !rule ||
        rule.mode !== 'live' ||
        rule.sourceId !== latest.sourceId ||
        rule.action.kind !== latest.action.kind ||
        source.repository !== latest.event.fields.repository ||
        !sourceGrantsRuleAction(source, rule)
      )
        return undefined;
      return {
        policyFingerprint: automationPolicyFingerprint(source, rule),
        authorityFingerprint: automationAuthorityFingerprint(source, rule),
        action: rule.action,
      };
    },
  });
}

/**
 * Text that is logged and shown to the operator: at most `max` code points
 * (a cut never splits a surrogate pair), with ASCII and C1 control
 * characters and the bidirectional mark, embedding, override and isolate
 * characters replaced by a space.
 */
export function boundedText(text: string, max = 200): string {
  return Array.from(text)
    .slice(0, max)
    .map((char) => (isFormattingControl(char.codePointAt(0) ?? 0) ? ' ' : char))
    .join('');
}

/** ASCII and C1 controls, and the bidirectional marks, embeddings, overrides and isolates. */
function isFormattingControl(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/** A Task no longer startable: canceled, done, or gone (undefined). */
function settledTaskStatus(status: string | undefined): boolean {
  return status === undefined || status === 'canceled' || status === 'done';
}

/** Failures a retry of the unchanged rule would meet again. */
const RULE_CHANGE_FAILURES = new Set([
  'agent-option-unsupported',
  'agent-own-approval-required',
]);

/**
 * The public episode view: the internal episode key is not returned. With
 * the current configuration, a start refused for the rule's approval
 * setting is marked `retryNeedsRuleChange` while the rule is unchanged. A
 * start whose Task could not be canceled keeps `task-not-canceled` only
 * while that Task is live: `taskStatus` reads its current status, and once
 * it is canceled or done (or gone) the failure is dropped so Retry returns.
 */
export function projectAutomationEpisode(
  record: AutomationEpisodeRecord,
  configuration?: AutomationConfiguration,
  taskStatus?: (taskId: string) => string | undefined,
): PublicEpisodeRecord {
  const taskSettled =
    record.startFailure === 'task-not-canceled' &&
    record.failedTaskId !== undefined &&
    taskStatus !== undefined &&
    settledTaskStatus(taskStatus(record.failedTaskId));
  const rule = configuration?.rules.find(({ id }) => id === record.ruleId);
  const source = configuration?.sources.find(({ id }) => id === rule?.sourceId);
  const unchanged =
    record.startFailure !== undefined &&
    RULE_CHANGE_FAILURES.has(record.startFailure) &&
    rule !== undefined &&
    source !== undefined &&
    automationPolicyFingerprint(source, rule) ===
      record.failedPolicyFingerprint;
  return {
    ruleId: record.ruleId,
    episodeId: record.episodeId,
    state: record.state,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    openedAt: record.openedAt,
    updatedAt: record.updatedAt,
    ...(record.startFailed ? { startFailed: true as const } : {}),
    ...(record.startFailure && !taskSettled
      ? { startFailure: record.startFailure }
      : {}),
    ...(unchanged ? { retryNeedsRuleChange: true as const } : {}),
  };
}

/**
 * #4511: the "Started by automation" view of a Task, from the intent bound
 * to that exact Task incarnation. Undefined for any other Task, for an
 * intent that captured no mandate, or for a recreated Task under a reused
 * id (its `createdAt` differs).
 */
export function readAutomationTaskProjection(
  ledger: Pick<AutomationLedger, 'intentForTask'> | undefined,
  task: Pick<TaskRecord, 'id' | 'createdAt' | 'createdBy'>,
): AutomationTaskProjection | undefined {
  if (!ledger || task.createdBy !== 'automation-rule') return undefined;
  const intent = ledger.intentForTask(task.id);
  if (!intent?.mandate || intent.taskCreatedAt !== task.createdAt)
    return undefined;
  return {
    mandate: intent.mandate,
    state: intent.state,
    amendments: intent.amendments ?? [],
    ...(intent.revocation ? { revocation: intent.revocation } : {}),
    ...(intent.personTakeoverAt
      ? { personTakeoverAt: intent.personTakeoverAt }
      : {}),
  };
}
