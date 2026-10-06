/**
 * Strict structural validation for the Automation configuration file.
 *
 * Every object is checked against an exact key set, so an unknown field is a
 * problem rather than something silently ignored: a hand-edited file that
 * spells a field wrong must not quietly lose a restriction. Matchers accept
 * only exact string values (or lists of them); any other shape is refused,
 * which is how a regex or expression form is kept out.
 *
 * This module returns problems and never throws, so the store decides how a
 * problem is reported (fail closed on read, refuse on write).
 */

import {
  AUTOMATION_ACTION_KINDS,
  AUTOMATION_EVENT_FIELDS,
  AUTOMATION_EXECUTION_LIMITS,
  AUTOMATION_SCHEMA_VERSION,
  type AutomationConfiguration,
  type AutomationEventType,
  type AutomationRule,
  type AutomationSource,
} from '@kontourai/station-contracts/automation';
import { isRecord } from '../../utils/is-record.js';

const LIMITS = AUTOMATION_EXECUTION_LIMITS;

/** `owner/repo` as GitHub spells it; no path segments, no wildcards. */
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const CONFIG_KEYS = ['schemaVersion', 'sources', 'rules'] as const;
const SOURCE_BASE_KEYS = [
  'id',
  'kind',
  'name',
  'repository',
  'enabled',
  'revokedAt',
  'grants',
] as const;
const SOURCE_KIND_KEYS = {
  'github-poll': ['credentialSecretBinding', 'pollIntervalMs'],
  'github-webhook': ['secret'],
} as const;
const GRANT_KEYS = ['projectId', 'agentId', 'actions'] as const;
const RULE_KEYS = [
  'id',
  'name',
  'enabled',
  'sourceId',
  'match',
  'episode',
  'action',
  'rateLimit',
] as const;
const MATCHER_KEYS = ['type', 'where'] as const;
const EPISODE_KEYS = ['keyFields', 'closeOn', 'maxAttempts'] as const;
const DISPATCH_KEYS = [
  'kind',
  'projectId',
  'agentId',
  'instructions',
  'approvalMode',
  'budget',
] as const;
const NOTIFY_KEYS = ['kind', 'priority'] as const;
const BUDGET_KEYS = ['maxTurns', 'maxTokens', 'maxWallRuntimeMs'] as const;
const RATE_LIMIT_KEYS = ['maxStartsPerHour'] as const;
const NOTIFY_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedName(value: unknown): value is string {
  return nonBlank(value) && value.length <= LIMITS.maxNameLength;
}

function boundedInteger(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${where}: unknown field ${key}`);
  }
}

function isEventType(value: unknown): value is AutomationEventType {
  return (
    typeof value === 'string' && Object.hasOwn(AUTOMATION_EVENT_FIELDS, value)
  );
}

function fieldsFor(type: AutomationEventType): readonly string[] {
  return AUTOMATION_EVENT_FIELDS[type];
}

function validateGrant(
  value: unknown,
  where: string,
  problems: string[],
): void {
  if (!isRecord(value)) {
    problems.push(`${where}: must be an object`);
    return;
  }
  unknownKeys(value, GRANT_KEYS, where, problems);
  if (!nonBlank(value.projectId)) problems.push(`${where}: projectId required`);
  if (!nonBlank(value.agentId)) problems.push(`${where}: agentId required`);
  if (!Array.isArray(value.actions)) {
    problems.push(`${where}: actions must be a list`);
    return;
  }
  const seen = new Set<unknown>();
  for (const action of value.actions) {
    if (!(AUTOMATION_ACTION_KINDS as readonly unknown[]).includes(action)) {
      problems.push(`${where}: unknown action ${String(action)}`);
    }
    if (seen.has(action)) problems.push(`${where}: duplicate action`);
    seen.add(action);
  }
}

function validateSource(
  value: unknown,
  where: string,
  problems: string[],
): void {
  if (!isRecord(value)) {
    problems.push(`${where}: must be an object`);
    return;
  }
  const kind = value.kind;
  if (kind !== 'github-poll' && kind !== 'github-webhook') {
    problems.push(`${where}: unknown source kind`);
    return;
  }
  unknownKeys(
    value,
    [...SOURCE_BASE_KEYS, ...SOURCE_KIND_KEYS[kind]],
    where,
    problems,
  );
  if (!nonBlank(value.id)) problems.push(`${where}: id required`);
  if (!boundedName(value.name)) problems.push(`${where}: name invalid`);
  if (
    typeof value.repository !== 'string' ||
    !REPOSITORY_PATTERN.test(value.repository)
  ) {
    problems.push(`${where}: repository must be owner/repo`);
  }
  if (typeof value.enabled !== 'boolean') {
    problems.push(`${where}: enabled must be a boolean`);
  }
  if (value.revokedAt !== undefined && !nonBlank(value.revokedAt)) {
    problems.push(`${where}: revokedAt invalid`);
  }
  if (value.grants !== undefined) {
    if (!Array.isArray(value.grants)) {
      problems.push(`${where}: grants must be a list`);
    } else if (value.grants.length > LIMITS.maxGrantsPerSource) {
      problems.push(`${where}: too many grants`);
    } else {
      value.grants.forEach((grant, index) =>
        validateGrant(grant, `${where}.grants[${index}]`, problems),
      );
    }
  }
  if (kind === 'github-webhook') {
    if (
      typeof value.secret !== 'string' ||
      value.secret.length < LIMITS.minWebhookSecretLength
    ) {
      problems.push(
        `${where}: secret must be at least ${LIMITS.minWebhookSecretLength} characters`,
      );
    }
  } else {
    if (
      value.credentialSecretBinding !== undefined &&
      !nonBlank(value.credentialSecretBinding)
    ) {
      problems.push(`${where}: credentialSecretBinding invalid`);
    }
    if (
      value.pollIntervalMs !== undefined &&
      !boundedInteger(
        value.pollIntervalMs,
        LIMITS.minPollIntervalMs,
        LIMITS.maxPollIntervalMs,
      )
    ) {
      problems.push(`${where}: pollIntervalMs out of range`);
    }
  }
}

/** Returns the matcher's event type when it is well-formed. */
function validateMatcher(
  value: unknown,
  where: string,
  problems: string[],
): AutomationEventType | undefined {
  if (!isRecord(value)) {
    problems.push(`${where}: must be an object`);
    return undefined;
  }
  unknownKeys(value, MATCHER_KEYS, where, problems);
  if (!isEventType(value.type)) {
    problems.push(`${where}: unknown event type`);
    return undefined;
  }
  const fields = fieldsFor(value.type);
  if (!isRecord(value.where)) {
    problems.push(`${where}.where: must be an object`);
    return value.type;
  }
  for (const [field, expected] of Object.entries(value.where)) {
    if (!fields.includes(field)) {
      problems.push(`${where}.where: unknown field ${field}`);
      continue;
    }
    // Exact equality only: a string, or a non-empty list of strings.
    if (typeof expected === 'string') continue;
    if (
      Array.isArray(expected) &&
      expected.length > 0 &&
      expected.length <= LIMITS.maxMatcherValues &&
      expected.every((member) => typeof member === 'string')
    ) {
      continue;
    }
    problems.push(`${where}.where.${field}: must be an exact string or list`);
  }
  return value.type;
}

function validateEpisode(
  value: unknown,
  type: AutomationEventType | undefined,
  where: string,
  problems: string[],
): void {
  if (!isRecord(value)) {
    problems.push(`${where}: must be an object`);
    return;
  }
  unknownKeys(value, EPISODE_KEYS, where, problems);
  if (
    !Array.isArray(value.keyFields) ||
    value.keyFields.length === 0 ||
    value.keyFields.length > LIMITS.maxEpisodeKeyFields ||
    new Set(value.keyFields).size !== value.keyFields.length
  ) {
    problems.push(
      `${where}: keyFields must be a non-empty list of unique fields`,
    );
  } else if (type) {
    const fields = fieldsFor(type);
    for (const field of value.keyFields) {
      if (typeof field !== 'string' || !fields.includes(field)) {
        problems.push(`${where}: unknown key field ${String(field)}`);
      }
    }
  }
  if (value.closeOn !== undefined) {
    const closeType = validateMatcher(
      value.closeOn,
      `${where}.closeOn`,
      problems,
    );
    if (closeType && type && closeType !== type) {
      problems.push(`${where}.closeOn: must match the rule's event type`);
    }
  }
  if (!boundedInteger(value.maxAttempts, 1, LIMITS.maxEpisodeAttempts)) {
    problems.push(`${where}: maxAttempts out of range`);
  }
}

function validateAction(
  value: unknown,
  where: string,
  problems: string[],
): void {
  if (!isRecord(value)) {
    problems.push(`${where}: must be an object`);
    return;
  }
  if (value.kind === 'notify') {
    unknownKeys(value, NOTIFY_KEYS, where, problems);
    if (!NOTIFY_PRIORITIES.includes(value.priority as string)) {
      problems.push(`${where}: unknown priority`);
    }
    return;
  }
  if (value.kind !== 'dispatch-task') {
    problems.push(`${where}: unknown action kind`);
    return;
  }
  unknownKeys(value, DISPATCH_KEYS, where, problems);
  if (!nonBlank(value.projectId)) problems.push(`${where}: projectId required`);
  if (!nonBlank(value.agentId)) problems.push(`${where}: agentId required`);
  if (
    !nonBlank(value.instructions) ||
    value.instructions.length > LIMITS.maxInstructionsLength
  ) {
    problems.push(`${where}: instructions invalid`);
  }
  if (
    value.approvalMode !== undefined &&
    value.approvalMode !== 'ask' &&
    value.approvalMode !== 'auto'
  ) {
    problems.push(`${where}: approvalMode invalid`);
  }
  const budget = value.budget;
  if (!isRecord(budget)) {
    problems.push(`${where}.budget: required`);
    return;
  }
  unknownKeys(budget, BUDGET_KEYS, `${where}.budget`, problems);
  for (const key of BUDGET_KEYS) {
    if (!boundedInteger(budget[key], 1, LIMITS.maxBudget[key])) {
      problems.push(`${where}.budget.${key}: out of range`);
    }
  }
}

/**
 * The two-keys rule: the rule's own action must also be granted by its
 * source. `dispatch-task` needs a grant naming the same Project and Agent;
 * `notify` needs the source to grant `notify` at all.
 */
function grantsAction(source: AutomationSource, rule: AutomationRule): boolean {
  const grants = source.grants ?? [];
  const action = rule.action;
  if (action.kind === 'notify') {
    return grants.some((grant) => grant.actions.includes('notify'));
  }
  return grants.some(
    (grant) =>
      grant.projectId === action.projectId &&
      grant.agentId === action.agentId &&
      grant.actions.includes('dispatch-task'),
  );
}

function validateRule(
  value: unknown,
  where: string,
  sources: ReadonlyMap<string, AutomationSource>,
  problems: string[],
): void {
  if (!isRecord(value)) {
    problems.push(`${where}: must be an object`);
    return;
  }
  const before = problems.length;
  unknownKeys(value, RULE_KEYS, where, problems);
  if (!nonBlank(value.id)) problems.push(`${where}: id required`);
  if (!boundedName(value.name)) problems.push(`${where}: name invalid`);
  if (typeof value.enabled !== 'boolean') {
    problems.push(`${where}: enabled must be a boolean`);
  }
  const type = validateMatcher(value.match, `${where}.match`, problems);
  if (value.episode !== undefined) {
    validateEpisode(value.episode, type, `${where}.episode`, problems);
  }
  validateAction(value.action, `${where}.action`, problems);
  if (!isRecord(value.rateLimit)) {
    problems.push(`${where}.rateLimit: required`);
  } else {
    unknownKeys(
      value.rateLimit,
      RATE_LIMIT_KEYS,
      `${where}.rateLimit`,
      problems,
    );
    if (
      !boundedInteger(
        value.rateLimit.maxStartsPerHour,
        1,
        LIMITS.maxStartsPerHour,
      )
    ) {
      problems.push(`${where}.rateLimit.maxStartsPerHour: out of range`);
    }
  }
  const source =
    typeof value.sourceId === 'string'
      ? sources.get(value.sourceId)
      : undefined;
  if (!source) {
    problems.push(`${where}: sourceId does not name a source`);
    return;
  }
  // Only a shape-valid rule is checked against its source's grants.
  if (
    problems.length === before &&
    !grantsAction(source, value as AutomationRule)
  ) {
    problems.push(`${where}: action is not granted by source ${source.id}`);
  }
}

/** Every problem with a candidate configuration; empty means valid. */
export function automationConfigurationProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ['configuration must be an object'];
  unknownKeys(value, CONFIG_KEYS, 'configuration', problems);
  if (value.schemaVersion !== AUTOMATION_SCHEMA_VERSION) {
    problems.push('configuration: unsupported schemaVersion');
  }
  if (!Array.isArray(value.sources) || !Array.isArray(value.rules)) {
    problems.push('configuration: sources and rules must be lists');
    return problems;
  }
  if (value.sources.length > LIMITS.maxSources) {
    problems.push('configuration: too many sources');
  }
  if (value.rules.length > LIMITS.maxRules) {
    problems.push('configuration: too many rules');
  }
  const sources = new Map<string, AutomationSource>();
  value.sources.forEach((source, index) => {
    const where = `sources[${index}]`;
    const before = problems.length;
    validateSource(source, where, problems);
    if (problems.length !== before) return;
    const valid = source as AutomationSource;
    if (sources.has(valid.id)) problems.push(`${where}: duplicate id`);
    sources.set(valid.id, valid);
  });
  const ruleIds = new Set<string>();
  value.rules.forEach((rule, index) => {
    const where = `rules[${index}]`;
    validateRule(rule, where, sources, problems);
    if (isRecord(rule) && typeof rule.id === 'string') {
      if (ruleIds.has(rule.id)) problems.push(`${where}: duplicate id`);
      ruleIds.add(rule.id);
    }
  });
  return problems;
}

export function isAutomationConfiguration(
  value: unknown,
): value is AutomationConfiguration {
  return automationConfigurationProblems(value).length === 0;
}
