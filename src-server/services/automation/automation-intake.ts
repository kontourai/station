/**
 * Automation intake (epic kontourai/station#3439): match a normalized event,
 * dedupe it, and atomically retain its delivery, episode changes and bounded
 * dispatch intent. Intake performs no provider calls; the action runtime
 * consumes the retained intent through the ledger's claim boundary.
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
  AutomationSource,
} from '@kontourai/station-contracts/automation';
import {
  automationAuthorityFingerprint,
  automationIntentId,
  automationPolicyFingerprint,
} from './automation-intent.js';
import type {
  AutomationLedger,
  RuleDecisionCandidate,
} from './automation-ledger.js';

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
function automationEpisodeId(event: AutomationEvent): string {
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
 * (`AutomationStore.actionableRules`), read for this delivery; an `off` rule
 * passed anyway is ignored.
 *
 * The delivery row and episode changes commit atomically. The dedupe gate ensures a duplicate
 * never reaches the episode effects, so re-observing a run cannot reopen or
 * re-close an episode. The row records the first matching `live` rule (or
 * the first matching rule when none is live); every matching `live` rule's
 * episode is opened.
 *
 * Only `live` rules open episodes or retain intents (#4509); a matching
 * `closeOn` closes the rule's episode in either mode. When a source is given, every matched rule also gets a
 * per-rule decision: `observe` rules are evaluated by the ledger without
 * writing anything a consumer could claim, so neither action consumer can
 * start work for them, now or after the rule is switched to `live`.
 */
export function recordAutomationEvent(input: {
  ledger: AutomationLedger;
  rules: readonly AutomationRule[];
  source?: AutomationSource;
  event: AutomationEvent;
  /** Transport identity; a polled event uses its semantic key. */
  transportId: string;
  now: number;
}): AutomationIntakeResult {
  const { ledger, event, now } = input;
  const rules = input.rules.filter((rule) => rule.mode !== 'off');
  const matched = rules.filter((rule) =>
    automationMatcherMatches(rule.match, event),
  );
  const acting = matched.filter((rule) => rule.mode === 'live');
  const closing = rules.filter(
    (rule) =>
      rule.episode?.closeOn !== undefined &&
      automationMatcherMatches(rule.episode.closeOn, event),
  );
  const rowRule = acting[0] ?? matched[0];
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
      ...(rowRule ? { ruleId: rowRule.id } : {}),
    },
    openings: acting.flatMap((rule) => {
      const episodeKey =
        automationEpisodeKey(rule, event) ??
        (input.source
          ? JSON.stringify([rule.id, event.semanticKey])
          : undefined);
      return episodeKey
        ? [
            {
              ruleId: rule.id,
              episodeKey,
              episodeId: automationEpisodeId(event),
              maxAttempts: rule.episode?.maxAttempts ?? 1,
              ...(!rule.episode ? { perDelivery: true } : {}),
              now,
            },
          ]
        : [];
    }),
    intents: input.source
      ? acting.flatMap((rule) => {
          const episodeKey =
            automationEpisodeKey(rule, event) ??
            JSON.stringify([rule.id, event.semanticKey]);
          const episodeId = automationEpisodeId(event);
          return [
            {
              intentId: automationIntentId(rule.id, episodeKey, episodeId),
              sourceId: event.sourceId,
              ruleId: rule.id,
              episodeKey,
              episodeId,
              policyFingerprint: automationPolicyFingerprint(
                input.source!,
                rule,
              ),
              authorityFingerprint: automationAuthorityFingerprint(
                input.source!,
                rule,
              ),
              event,
              action: rule.action,
            },
          ];
        })
      : [],
    // Closing follows the rule in either mode: `closeOn` records that the
    // failure resolved, starts nothing and consumes no attempt, and an
    // episode left open while observing would suppress the rule's next
    // failure once it is live again.
    closings: closing.flatMap((rule) => {
      const episodeKey = automationEpisodeKey(rule, event);
      return episodeKey ? [{ ruleId: rule.id, episodeKey }] : [];
    }),
    decisions: input.source
      ? matched.flatMap((rule): RuleDecisionCandidate[] => {
          if (rule.mode === 'off') return [];
          return [
            {
              ruleId: rule.id,
              ruleName: rule.name,
              mode: rule.mode,
              actionKind: rule.action.kind,
              projectId: rule.action.projectId,
              agentId: rule.action.agentId,
              episodeKey:
                automationEpisodeKey(rule, event) ??
                JSON.stringify([rule.id, event.semanticKey]),
              episodeId: automationEpisodeId(event),
              keyedEpisode: rule.episode !== undefined,
              maxStartsPerHour: rule.rateLimit.maxStartsPerHour,
            },
          ];
        })
      : [],
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
