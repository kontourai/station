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
 * its rules stay stored. Sources are created disabled; rules are created in
 * `observe` mode, which records what they would do but never acts.
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
export const AUTOMATION_ACTION_KINDS = [
  'dispatch-task',
  'isolated-repair',
  'publish-branch',
  'notify',
] as const;

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
      kind: 'isolated-repair';
      projectId: string;
      agentId: string;
      profileId: string;
      instructions: string;
      /** Provider requests and wall time; this is not a token or turn limit. */
      budget: Readonly<{
        maxProviderRequests: number;
        maxWallRuntimeMs: number;
      }>;
    }>
  | Readonly<{
      kind: 'notify';
      priority: 'low' | 'normal' | 'high' | 'urgent';
    }>;

/** Private durable dispatch record; it is never accepted as request authority. */
export interface AutomationActionIntent {
  intentId: string;
  sourceId: string;
  ruleId: string;
  episodeKey: string;
  episodeId: string;
  deliveryKey: string;
  policyFingerprint: string;
  event: AutomationEvent;
  action: Extract<
    AutomationAction,
    { kind: 'dispatch-task' | 'isolated-repair' }
  >;
  state:
    | 'pending'
    | 'invoking'
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'indeterminate'
    | 'refused';
  createdAt: number;
  updatedAt: number;
  deadlineAt?: number;
  taskId?: string;
  taskCreatedAt?: string;
  sessionId?: string;
  conversationId?: string;
  turnId?: string;
  reason?: string;
}

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

/**
 * What a rule does with a matching event (#4509).
 *
 * - `off`: the rule is ignored, as a disabled rule always was.
 * - `observe`: intake checks the rule's episode, concurrency, active and
 *   hourly-start limits against current `live` load and records a per-rule
 *   decision (`would-start` or `suppressed`) on the delivery. It never
 *   retains a dispatchable intent, opens a real episode, claims an action or
 *   consumes an attempt, so neither action consumer can start work for it.
 *   The rule's own earlier `would-start`s count toward its hourly limit but
 *   never as active work: the limits do not model what the rule would be
 *   running had it been `live`.
 * - `live`: the rule acts, subject to the source grant, the
 *   `github-automation-actions` / `isolated-github-repairs` previews and the
 *   other admission checks.
 *
 * Switching a rule from `observe` to `live` acts only on events that arrive
 * afterwards; earlier observed events are never replayed.
 */
export const AUTOMATION_RULE_MODES = ['off', 'observe', 'live'] as const;

export type AutomationRuleMode = (typeof AUTOMATION_RULE_MODES)[number];

export type AutomationRule = Readonly<{
  /** Server-issued; a recreated rule is a new `automation-rule` principal. */
  id: string;
  name: string;
  /**
   * Created `observe`; only an operator surface may set `live`. A stored
   * rule written before #4509 carries `enabled: boolean` instead; the
   * server reads `false` as `off` and `true` as `live`, and writes `mode`.
   */
  mode: AutomationRuleMode;
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

/**
 * Why a matched delivery started nothing. `rule-active-limit` and
 * `concurrency-limit` are recorded only by an `observe` rule's decision: a
 * `live` action held by those limits waits and is admitted later, so they
 * mean "would have waited at the time of evaluation", not a refusal.
 */
export const AUTOMATION_SUPPRESSION_REASONS = [
  'episode-active',
  'episode-exhausted',
  'episode-indeterminate',
  'rate-limited',
  'rule-active-limit',
  'concurrency-limit',
] as const;

export type AutomationSuppressionReason =
  (typeof AUTOMATION_SUPPRESSION_REASONS)[number];

/**
 * What intake decided for one matched rule on one delivery (#4509).
 *
 * - `would-start`: an `observe` rule passed every admission check intake can
 *   evaluate. Only `observe` rules record it.
 * - `suppressed`: the rule matched but would not (observe) or could not
 *   (live) start; `reason` says why.
 * - `intent-retained`: a `live` rule's dispatchable intent was retained for
 *   its action consumer. Whether it then starts is decided later, by that
 *   consumer, and is reflected in the delivery's `outcome`, not here.
 */
export const AUTOMATION_RULE_DECISION_OUTCOMES = [
  'would-start',
  'suppressed',
  'intent-retained',
] as const;

export type AutomationRuleDecisionOutcome =
  (typeof AUTOMATION_RULE_DECISION_OUTCOMES)[number];

/**
 * One rule's decision for one delivery, with a bounded snapshot of the
 * action it names. Recorded for every matched `observe` or `live` rule with
 * a `dispatch-task` or `isolated-repair` action; `notify` rules record none.
 * It carries no instructions, event fields or payload.
 */
export type AutomationRuleDecision = Readonly<{
  ruleId: string;
  /** The rule's name when the decision was recorded. */
  ruleName: string;
  mode: Exclude<AutomationRuleMode, 'off'>;
  outcome: AutomationRuleDecisionOutcome;
  /** Present only when `outcome` is `suppressed`. */
  reason?: AutomationSuppressionReason;
  actionKind: Extract<
    AutomationActionKind,
    'dispatch-task' | 'isolated-repair'
  >;
  projectId: string;
  agentId: string;
  /** The episode this event belongs to, e.g. the first failing run id. */
  episodeId: string;
  decidedAt: string;
}>;

/**
 * Bounded, payload-free view of one recorded delivery, as the ledger keeps it
 * and `GET /automations/deliveries` returns it. It holds no payload, secret
 * or delivery GUID: `deliveryKey` is a sha256 of the source id and transport
 * id.
 */
export type AutomationDeliveryRecord = Readonly<{
  deliveryKey: string;
  sourceId: string;
  /** e.g. `workflow_run:<id>:<attempt>:completed`. */
  semanticKey: string;
  eventType: string;
  receivedAt: string;
  updatedAt: string;
  outcome: AutomationDeliveryOutcome;
  reason?: AutomationRefusalReason | AutomationSuppressionReason;
  ruleId?: string;
  episodeId?: string;
  taskId?: string;
  sessionId?: string;
  /**
   * Per-rule decisions, ordered by rule id; omitted when none was recorded.
   * The delivery's own `ruleId`, `outcome` and `episodeId` describe one rule
   * (a `live` rule when any matched); these describe every matched rule.
   */
  decisions?: readonly AutomationRuleDecision[];
}>;

export type AutomationPollOutcome =
  | 'ok'
  | 'partial'
  | 'unauthorized'
  | 'unavailable';

export interface AutomationPollRecord {
  sourceId: string;
  lastPolledAt: string;
  cursorAt?: string;
  lastOutcome: AutomationPollOutcome;
}

export interface AutomationDeliveryPage {
  deliveries: AutomationDeliveryRecord[];
  polls: AutomationPollRecord[];
}

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
 * An agent may instead PROPOSE a source or rule (#4830,
 * {@link AutomationProposal}); only a person's confirmation creates it.
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

/**
 * #4830: an agent proposes, a person confirms. An agent in a person's chat
 * may ask for an Automation source or rule; Station validates it, renders a
 * plain description of what it would do, and creates nothing until a person
 * confirms it. What a proposal may name is narrower than what an operator may
 * create: a credential-free `github-poll` source, and a `dispatch-task` rule
 * that never pins `auto` approval. Every Project/Agent it names must be one
 * the proposing chat could dispatch work to itself.
 */
export const AUTOMATION_PROPOSAL_KINDS = ['source', 'rule'] as const;

export type AutomationProposalKind = (typeof AUTOMATION_PROPOSAL_KINDS)[number];

/**
 * `open` waits for a person; `confirmed` created the source or rule
 * (`createdId`); `declined` created nothing.
 */
export type AutomationProposalState = 'open' | 'confirmed' | 'declined';

/** The source an agent may propose: polling only, with no credential. */
export type AutomationSourceProposalInput = Readonly<{
  kind: 'github-poll';
  name: string;
  repository: string;
  pollIntervalMs?: number;
  /** Each grant may list only `dispatch-task`. */
  grants?: readonly AutomationGrant[];
}>;

/**
 * The rule an agent may propose. It names exactly one of an existing
 * `sourceId` or a source proposal from the same chat (`sourceProposalId`),
 * which must be confirmed first.
 */
export type AutomationRuleProposalInput = Readonly<{
  name: string;
  sourceId?: string;
  sourceProposalId?: string;
  match: AutomationMatcher;
  episode?: AutomationEpisodePolicy;
  action: Readonly<{
    kind: 'dispatch-task';
    projectId: string;
    agentId: string;
    instructions: string;
    /** Only `ask`; omitted also runs as `ask`. */
    approvalMode?: 'ask';
    budget: AutomationBudget;
  }>;
  rateLimit: Readonly<{ maxStartsPerHour: number }>;
}>;

/**
 * Plain sentences Station renders from a validated proposal, so the person
 * confirms what will happen rather than reading JSON. `untrusted` is present
 * only when the proposing chat had read content written by others.
 */
export type AutomationProposalDescription = Readonly<{
  title: string;
  watches: string;
  opens: string;
  wakes: string;
  authority: string;
  startsAs: string;
  /** What confirming with `enable: true` would do instead. */
  ifEnabled: string;
  untrusted?: string;
}>;

type AutomationProposalBase = Readonly<{
  id: string;
  conversationId: string;
  description: AutomationProposalDescription;
  /**
   * The proposing chat had read untrusted content (#3483) when it proposed
   * this. Kept as recorded.
   */
  untrustedContent: boolean;
  /**
   * The chat is marked now, as read when this was listed. Absent when it was
   * not read. A person sees a warning when this or `untrustedContent` is set.
   */
  untrustedContentNow?: boolean;
  /** The chat's mark when a person confirmed it; present once confirmed. */
  untrustedContentAtConfirm?: boolean;
  rationale?: string;
  state: AutomationProposalState;
  /** The created source's or rule's id, once confirmed. */
  createdId?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type AutomationProposal =
  | (AutomationProposalBase &
      Readonly<{ kind: 'source'; source: AutomationSourceProposalInput }>)
  | (AutomationProposalBase &
      Readonly<{ kind: 'rule'; rule: AutomationRuleProposalInput }>);

/**
 * A person's confirmation. `enable` defaults to false: the source is created
 * disabled, the rule in `observe` mode. `true` creates an enabled source, or
 * a `live` rule, in the same step.
 */
export type AutomationProposalConfirmation = Readonly<{ enable?: boolean }>;

/** Shown when the proposing chat had read untrusted content before proposing. */
export const AUTOMATION_PROPOSAL_UNTRUSTED_COPY =
  'This chat had read content written by others (such as email or web pages) before the agent proposed this. That content may have steered it: check it is what you asked for.';

/** Shown when the chat was marked only after the agent proposed this. */
export const AUTOMATION_PROPOSAL_UNTRUSTED_SINCE_COPY =
  'This chat has read content written by others (such as email or web pages) since the agent proposed this. Check it is still what you asked for.';

export const AUTOMATION_PROPOSAL_LIMITS = {
  maxOpenPerConversation: 3,
  maxCreatedPerHour: 10,
  maxRationaleLength: 2_000,
} as const;

export const AUTOMATION_PROPOSAL_REFUSAL_CODES = [
  'automation_proposal_invalid',
  'automation_proposal_exceeds_authority',
  'automation_proposal_unattended',
  'automation_proposal_limit_reached',
  'automation_proposal_rate_limited',
  'automation_proposal_unavailable',
] as const;

export type AutomationProposalRefusalCode =
  (typeof AUTOMATION_PROPOSAL_REFUSAL_CODES)[number];
