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
 * enabled, unrevoked source.
 */
export function retryAutomationEpisode(input: {
  ledger: Pick<AutomationLedger, 'retryEpisode'>;
  read: () => AutomationConfiguration;
  ruleId: string;
  episodeId: string;
  now: number;
}): RetryEpisodeOutcome {
  return input.ledger.retryEpisode({
    ruleId: input.ruleId,
    episodeId: input.episodeId,
    now: input.now,
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

/** The public episode view: the internal episode key is not returned. */
export function projectAutomationEpisode(
  record: AutomationEpisodeRecord,
): PublicEpisodeRecord {
  return {
    ruleId: record.ruleId,
    episodeId: record.episodeId,
    state: record.state,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    openedAt: record.openedAt,
    updatedAt: record.updatedAt,
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
