/**
 * Automation intake, observe-only (slice S2 of epic kontourai/station#3439):
 * dedupe a normalized event, match it against a source's actionable rules,
 * record the outcome, and open or close episodes. It starts nothing; the
 * `dispatch-task` action arrives in S3 and claims through the same ledger.
 *
 * Matching is exact string equality over normalized fields only (design
 * section 3): no regex, glob, negation or expression form.
 */

import type {
  AutomationDeliveryOutcome,
  AutomationEvent,
  AutomationMatcher,
  AutomationRefusalReason,
  AutomationRule,
} from '@kontourai/station-contracts/automation';
import type { AutomationLedger } from './automation-ledger.js';

/** Every `where` entry holds; an array matches any member; empty never matches. */
export function automationMatcherMatches(
  matcher: AutomationMatcher,
  event: AutomationEvent,
): boolean {
  if (matcher.type !== event.type) return false;
  const entries = Object.entries(matcher.where);
  if (entries.length === 0) return false;
  return entries.every(([field, expected]) => {
    if (!Object.hasOwn(event.fields, field)) return false;
    const actual = event.fields[field];
    return typeof expected === 'string'
      ? actual === expected
      : expected.includes(actual);
  });
}

/**
 * The rule id plus each key field's value, JSON-encoded so no value can
 * forge a separator. Undefined when the event lacks a key field: such an
 * event cannot belong to a keyed episode.
 */
export function automationEpisodeKey(
  rule: AutomationRule,
  event: AutomationEvent,
): string | undefined {
  if (!rule.episode) return undefined;
  const values: string[] = [];
  for (const field of rule.episode.keyFields) {
    if (!Object.hasOwn(event.fields, field)) return undefined;
    values.push(event.fields[field]);
  }
  return JSON.stringify([rule.id, ...values]);
}

/**
 * Design section 6: the episode id is the first failing run's id, the same
 * as CI's issue marker. A re-run attempt that fails after that episode
 * closed opens a new episode for the same rule, and `(rule, episode id)` is
 * unique for life, so attempts after the first carry their attempt number.
 */
export function automationEpisodeId(event: AutomationEvent): string {
  const runId = event.fields['run.id'];
  const attempt = event.fields['run.run_attempt'];
  if (!runId) return event.semanticKey;
  return attempt && attempt !== '1' ? `${runId}.${attempt}` : runId;
}

export type AutomationIntakeResult = Readonly<{
  outcome: Extract<
    AutomationDeliveryOutcome,
    'duplicate' | 'ignored' | 'no-match' | 'matched'
  >;
  /** `transport` duplicates write no row; every other result wrote one. */
  duplicateLayer?: 'transport' | 'semantic';
  matchedRuleIds: readonly string[];
  openedEpisodeIds: readonly string[];
  closedEpisodeIds: readonly string[];
}>;

/**
 * Records one accepted event. `rules` must be the source's actionable rules
 * (`AutomationStore.actionableRules`), read for this delivery.
 *
 * The delivery row and episode changes commit atomically. The dedupe gate ensures a duplicate
 * never reaches the episode effects, so re-observing a run cannot reopen or
 * re-close an episode. The row records the first matching rule; the ledger
 * holds one rule per delivery, and every matching rule's episode is opened.
 */
export function recordAutomationEvent(input: {
  ledger: AutomationLedger;
  rules: readonly AutomationRule[];
  event: AutomationEvent;
  /** Transport identity; a polled event uses its semantic key. */
  transportId: string;
  now: number;
}): AutomationIntakeResult {
  const { ledger, rules, event, now } = input;
  const matched = rules.filter((rule) =>
    automationMatcherMatches(rule.match, event),
  );
  const closing = rules.filter(
    (rule) =>
      rule.episode?.closeOn !== undefined &&
      automationMatcherMatches(rule.episode.closeOn, event),
  );
  const outcome =
    rules.length === 0
      ? 'ignored'
      : matched.length > 0
        ? 'matched'
        : 'no-match';
  const { recorded, openedEpisodeIds, closedEpisodeIds } = ledger.recordIntake({
    delivery: {
      sourceId: event.sourceId,
      transportId: input.transportId,
      semanticKey: event.semanticKey,
      eventType: event.type,
      receivedAt: now,
      outcome,
      ...(matched[0] ? { ruleId: matched[0].id } : {}),
    },
    openings: matched.flatMap((rule) => {
      const episodeKey = automationEpisodeKey(rule, event);
      return rule.episode && episodeKey
        ? [
            {
              ruleId: rule.id,
              episodeKey,
              episodeId: automationEpisodeId(event),
              maxAttempts: rule.episode.maxAttempts,
              now,
            },
          ]
        : [];
    }),
    closings: closing.flatMap((rule) => {
      const episodeKey = automationEpisodeKey(rule, event);
      return episodeKey ? [{ ruleId: rule.id, episodeKey }] : [];
    }),
    now,
  });
  if (recorded.kind === 'duplicate')
    return {
      outcome: 'duplicate',
      duplicateLayer: recorded.layer,
      matchedRuleIds: [],
      openedEpisodeIds: [],
      closedEpisodeIds: [],
    };
  return {
    outcome,
    matchedRuleIds: matched.map(({ id }) => id),
    openedEpisodeIds,
    closedEpisodeIds,
  };
}

/** Records a refused delivery. A refusal never occupies a dedupe key. */
export function recordAutomationRefusal(input: {
  ledger: AutomationLedger;
  sourceId: string;
  semanticKey: string;
  eventType: string;
  reason: AutomationRefusalReason;
  now: number;
}): void {
  input.ledger.recordDelivery({
    sourceId: input.sourceId,
    transportId: input.semanticKey,
    semanticKey: input.semanticKey,
    eventType: input.eventType,
    receivedAt: input.now,
    outcome: 'refused',
    reason: input.reason,
  });
}
