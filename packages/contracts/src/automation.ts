/**
 * Station Automations: event sources, rules and their bounded outcomes
 * (epic kontourai/station#3439).
 *
 * An Automation turns an authenticated external event into at most one
 * bounded Station action. This module holds the shapes and published
 * ceilings only; validation, storage and dispatch live in the server
 * (`src-server/services/automation/`).
 *
 * Authority follows the inbound-webhook rule: an omitted grant list is an
 * empty grant, never a wildcard. A rule is valid only when its source also
 * grants its action (the "two keys" rule), so neither a source nor a rule
 * alone can start work: a `dispatch-task` rule needs a source grant naming
 * the same `projectId` and `agentId` with `dispatch-task`, and a `notify`
 * rule (which names no Project or Agent) needs some source grant listing
 * `notify`. A revoked or disabled source grants nothing at run time, though
 * its rules stay stored. Sources and rules are created disabled.
 */

/** Current version of every persisted Automation record in this module. */
export const AUTOMATION_SCHEMA_VERSION = 1 as const;

/**
 * Event sources with a defined shape. `github-poll` observes GitHub without
 * any ingress; `github-webhook` receives GitHub's signed push deliveries.
 */
export const AUTOMATION_SOURCE_KINDS = [
  'github-poll',
  'github-webhook',
] as const;

export type AutomationSourceKind = (typeof AUTOMATION_SOURCE_KINDS)[number];

/** Actions a rule may take. A grant names the subset a source permits. */
export const AUTOMATION_ACTION_KINDS = ['dispatch-task', 'notify'] as const;

export type AutomationActionKind = (typeof AUTOMATION_ACTION_KINDS)[number];

/**
 * One Project/Agent pair a source permits rules to act through. An omitted
 * or empty `actions` list grants nothing.
 */
export type AutomationGrant = Readonly<{
  projectId: string;
  agentId: string;
  actions: readonly AutomationActionKind[];
}>;

type AutomationSourceBase = Readonly<{
  /** Server-issued, opaque; a recreated source is a new identity. */
  id: string;
  name: string;
  /** `owner/repo`, compared exactly with the event's repository. */
  repository: string;
  /** Created `false`; only an operator surface may enable a source. */
  enabled: boolean;
  revokedAt?: string;
  /** Omitted means no authority: no rule on this source may act. */
  grants?: readonly AutomationGrant[];
}>;

/** Polls GitHub's REST API; needs no inbound route. */
export type GitHubPollAutomationSource = AutomationSourceBase &
  Readonly<{
    kind: 'github-poll';
    /** Exact existing secret-binding id; the token value is never stored here. */
    credentialSecretBinding?: string;
    /**
     * Interval between polls. Bounded by
     * `AUTOMATION_EXECUTION_LIMITS.minPollIntervalMs`/`maxPollIntervalMs`;
     * omitted means `defaultPollIntervalMs`.
     */
    pollIntervalMs?: number;
  }>;

/** Receives GitHub webhook deliveries signed with `X-Hub-Signature-256`. */
export type GitHubWebhookAutomationSource = AutomationSourceBase &
  Readonly<{
    kind: 'github-webhook';
    /**
     * Local-only HMAC secret, at least
     * `AUTOMATION_EXECUTION_LIMITS.minWebhookSecretLength` characters. Never
     * project it to an API response, event, ledger row or log; use
     * {@link AutomationSourceProjection}.
     */
    secret: string;
  }>;

export type AutomationSource =
  | GitHubPollAutomationSource
  | GitHubWebhookAutomationSource;

/**
 * The API-safe view of a source. The webhook secret is removed and replaced
 * by a presence flag, so a response can say a secret exists without
 * carrying it.
 */
export type AutomationSourceProjection =
  | GitHubPollAutomationSource
  | (Omit<GitHubWebhookAutomationSource, 'secret'> &
      Readonly<{ hasSecret: true }>);

/**
 * GitHub webhook events and actions Station normalizes. Anything else is
 * acknowledged and recorded as `ignored`, never matched.
 */
export const GITHUB_AUTOMATION_EVENT_ALLOWLIST = {
  workflow_run: ['completed'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * Normalized event types, `github.<event>.<action>`, derived from
 * {@link GITHUB_AUTOMATION_EVENT_ALLOWLIST}.
 */
export type AutomationEventType = {
  [Event in keyof typeof GITHUB_AUTOMATION_EVENT_ALLOWLIST]: `github.${Event}.${(typeof GITHUB_AUTOMATION_EVENT_ALLOWLIST)[Event][number]}`;
}[keyof typeof GITHUB_AUTOMATION_EVENT_ALLOWLIST];

/**
 * The only fields a normalized event may carry, per event type. Matchers
 * and episode keys may name only these. Actor-supplied free text (commit
 * messages, display titles) is deliberately absent.
 */
export const AUTOMATION_EVENT_FIELDS = {
  'github.workflow_run.completed': [
    'repository',
    'workflow.path',
    'run.id',
    'run.run_attempt',
    'run.event',
    'run.conclusion',
    'run.head_branch',
    'run.head_repository',
    'run.head_sha',
    'run.html_url',
  ],
} as const satisfies Readonly<Record<AutomationEventType, readonly string[]>>;

/** A normalized, allow-listed event. It never carries the raw payload. */
export type AutomationEvent = Readonly<{
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  eventId: string;
  sourceId: string;
  sourceKind: AutomationSourceKind;
  type: AutomationEventType;
  /** Transport delivery id (`X-GitHub-Delivery`); absent for polled events. */
  deliveryId?: string;
  /** Source-independent identity, e.g. `workflow_run:<id>:<attempt>:<action>`. */
  semanticKey: string;
  occurredAt: string;
  receivedAt: string;
  /**
   * Allow-listed fields, all strings. The normalizer writes a numeric value
   * (a run id, a run attempt) as its canonical decimal string, `String(n)`,
   * so a matcher compares `'123'` with `'123'` and never a number with a
   * string.
   */
  fields: Readonly<Record<string, string>>;
}>;

/**
 * Exact-equality matcher. Every `where` entry must hold; an array value
 * matches when the field equals any member. Values are strings because
 * event fields are (numbers arrive as canonical decimal strings). There is
 * no regex, glob, negation or expression form. `where` must name at least
 * one field: an empty `where` is refused rather than matching every event
 * of its type.
 */
export type AutomationMatcher = Readonly<{
  type: AutomationEventType;
  where: Readonly<Record<string, string | readonly string[]>>;
}>;

/** Per-action ceiling, enforced by the Task turn supervisor. */
export type AutomationBudget = Readonly<{
  maxTurns: number;
  maxTokens: number;
  maxWallRuntimeMs: number;
}>;

export type AutomationAction =
  | Readonly<{
      kind: 'dispatch-task';
      projectId: string;
      agentId: string;
      /** Operator instructions; event data is appended separately as untrusted. */
      instructions: string;
      /** Never wider than the Agent's own approval mode; omitted means the Agent's. */
      approvalMode?: 'ask' | 'auto';
      budget: AutomationBudget;
    }>
  | Readonly<{
      kind: 'notify';
      priority: 'low' | 'normal' | 'high' | 'urgent';
    }>;

/**
 * Groups related events into one episode so a failure that keeps recurring
 * starts at most `maxAttempts` actions until `closeOn` resolves it.
 */
export type AutomationEpisodePolicy = Readonly<{
  /** Event fields whose values, with the rule id, form the episode key. */
  keyFields: readonly string[];
  closeOn?: AutomationMatcher;
  maxAttempts: number;
}>;

export type AutomationRule = Readonly<{
  /** Server-issued; a recreated rule is a new `automation-rule` principal. */
  id: string;
  name: string;
  /** Created `false`; only an operator surface may enable a rule. */
  enabled: boolean;
  sourceId: string;
  match: AutomationMatcher;
  episode?: AutomationEpisodePolicy;
  action: AutomationAction;
  rateLimit: Readonly<{ maxStartsPerHour: number }>;
}>;

/** Private Station-home configuration holding every source and rule. */
export type AutomationConfiguration = Readonly<{
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  sources: readonly AutomationSource[];
  rules: readonly AutomationRule[];
}>;

/** Every recorded outcome for one delivery. The list is closed. */
export const AUTOMATION_DELIVERY_OUTCOMES = [
  'received',
  'duplicate',
  'refused',
  'ignored',
  'no-match',
  'matched',
  'suppressed',
  'started',
  'failed',
  'indeterminate',
] as const;

export type AutomationDeliveryOutcome =
  (typeof AUTOMATION_DELIVERY_OUTCOMES)[number];

/**
 * Outcomes of a delivery that was authenticated and accepted for
 * evaluation. Only these take part in semantic dedupe, so a refused (for
 * example forged, with a guessable run id) or transiently refused delivery
 * can never turn the genuine delivery that follows it into a duplicate.
 */
export const AUTOMATION_SEMANTIC_DEDUPE_OUTCOMES = [
  'ignored',
  'no-match',
  'matched',
  'suppressed',
  'started',
  'failed',
  'indeterminate',
] as const satisfies readonly AutomationDeliveryOutcome[];

/** Why a delivery was `refused`. */
export const AUTOMATION_REFUSAL_REASONS = [
  'disabled',
  'unknown_source',
  'revoked_source',
  'invalid_signature',
  'wrong_repository',
  'stale_event',
  'malformed_request',
  'rate_limited',
  'policy_unavailable',
] as const;

export type AutomationRefusalReason =
  (typeof AUTOMATION_REFUSAL_REASONS)[number];

/** Why a matched delivery started nothing. */
export const AUTOMATION_SUPPRESSION_REASONS = [
  'episode-active',
  'episode-exhausted',
  'episode-indeterminate',
  'rate-limited',
] as const;

export type AutomationSuppressionReason =
  (typeof AUTOMATION_SUPPRESSION_REASONS)[number];

/**
 * Episode lifecycle. `open` may still act; `exhausted` used every allowed
 * attempt; `indeterminate` had an action whose result is unknown and is
 * never replayed; `closed` was resolved by `closeOn`.
 */
export type AutomationEpisodeState =
  | 'open'
  | 'exhausted'
  | 'indeterminate'
  | 'closed';

/**
 * Self-imposed ceilings. Published so consumers can explain refusals;
 * changing a value is an explicit contract change.
 */
export const AUTOMATION_EXECUTION_LIMITS = {
  /** Automation actions one Station process runs at once. */
  maxConcurrentActions: 2,
  /** Actions one rule may have running at once. */
  maxActivePerRule: 1,
  defaultMaxStartsPerHour: 2,
  maxStartsPerHour: 12,
  defaultEpisodeMaxAttempts: 1,
  maxEpisodeAttempts: 3,
  maxSources: 64,
  maxRules: 256,
  maxGrantsPerSource: 32,
  maxInstructionsLength: 8_192,
  maxNameLength: 128,
  maxMatcherValues: 16,
  maxEpisodeKeyFields: 8,
  /** Matches the inbound-webhook secret floor. */
  minWebhookSecretLength: 32,
  minPollIntervalMs: 60_000,
  defaultPollIntervalMs: 300_000,
  maxPollIntervalMs: 86_400_000,
  /** Transport dedupe outlives GitHub's three-day redelivery window. */
  deliveryRetentionMs: 7 * 24 * 60 * 60 * 1000,
  /** Signed events older than this are refused as `stale_event`. */
  maxEventAgeMs: 72 * 60 * 60 * 1000,
  /**
   * Retained delivery rows outside the semantic-dedupe outcomes (refused,
   * received, duplicate); the oldest beyond this are pruned. Accepted rows
   * are bounded only by `deliveryRetentionMs`.
   */
  maxRetainedDeliveries: 50_000,
  /** Closed episodes older than this are pruned. */
  closedEpisodeRetentionMs: 31 * 24 * 60 * 60 * 1000,
  /** Byte ceiling for the stored configuration file. */
  maxConfigurationBytes: 1_048_576,
  /** Ids, Project/Agent ids and secret-binding ids. */
  maxIdLength: 128,
  maxRepositoryLength: 200,
  maxWebhookSecretLength: 256,
  /** Each matcher value and each episode key field value. */
  maxMatcherValueLength: 256,
  maxBudget: {
    maxTurns: 20,
    maxTokens: 2_000_000,
    maxWallRuntimeMs: 4 * 60 * 60 * 1000,
  },
} as const;

/**
 * Operator-facing Automation verbs. API, SDK and CLI must expose this exact
 * set. Station-control MCP exposes only the read verbs: an agent must never
 * create, widen or enable its own triggers, so a mutation's `mcp` is `null`.
 */
export const AUTOMATION_OPERATOR_OPERATIONS = [
  'list-sources',
  'create-source',
  'enable-source',
  'disable-source',
  'delete-source',
  'list-rules',
  'create-rule',
  'enable-rule',
  'disable-rule',
  'delete-rule',
  'deliveries',
  'episodes',
  'retry-episode',
] as const;

export type AutomationOperatorOperation =
  (typeof AUTOMATION_OPERATOR_OPERATIONS)[number];

/** Stable adapter names used by parity ratchets. */
export const AUTOMATION_OPERATOR_SURFACE: Readonly<
  Record<
    AutomationOperatorOperation,
    Readonly<{ cli: string; mcp: string | null; method: string; path: string }>
  >
> = {
  'list-sources': {
    cli: 'sources',
    mcp: 'list_automation_sources',
    method: 'GET',
    path: '/automations/sources',
  },
  'create-source': {
    cli: 'source-create',
    mcp: null,
    method: 'POST',
    path: '/automations/sources',
  },
  'enable-source': {
    cli: 'source-enable',
    mcp: null,
    method: 'PUT',
    path: '/automations/sources/:target/enable',
  },
  'disable-source': {
    cli: 'source-disable',
    mcp: null,
    method: 'PUT',
    path: '/automations/sources/:target/disable',
  },
  'delete-source': {
    cli: 'source-delete',
    mcp: null,
    method: 'DELETE',
    path: '/automations/sources/:target',
  },
  'list-rules': {
    cli: 'rules',
    mcp: 'list_automation_rules',
    method: 'GET',
    path: '/automations/rules',
  },
  'create-rule': {
    cli: 'rule-create',
    mcp: null,
    method: 'POST',
    path: '/automations/rules',
  },
  'enable-rule': {
    cli: 'enable',
    mcp: null,
    method: 'PUT',
    path: '/automations/rules/:target/enable',
  },
  'disable-rule': {
    cli: 'disable',
    mcp: null,
    method: 'PUT',
    path: '/automations/rules/:target/disable',
  },
  'delete-rule': {
    cli: 'delete',
    mcp: null,
    method: 'DELETE',
    path: '/automations/rules/:target',
  },
  deliveries: {
    cli: 'deliveries',
    mcp: 'list_automation_deliveries',
    method: 'GET',
    path: '/automations/deliveries',
  },
  episodes: {
    cli: 'episodes',
    mcp: 'list_automation_episodes',
    method: 'GET',
    path: '/automations/episodes',
  },
  'retry-episode': {
    cli: 'retry-episode',
    mcp: null,
    method: 'POST',
    path: '/automations/episodes/:target/retry',
  },
};
