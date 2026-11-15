/**
 * #4830: an agent proposes an Automation source or rule, and a person
 * confirms it. This module holds the proposal records, the validation of what
 * an agent may propose, the plain description a person confirms, and the
 * derivation of whether the proposing Session was started by an automation.
 * Routes live in `routes/orchestration/automation-proposals.ts`; creation
 * goes through the ordinary {@link AutomationStore} only after a person
 * confirms.
 *
 * What an agent may propose is narrower than what an operator may create:
 *
 * - a `github-poll` source with no stored credential (a credential, and a
 *   webhook secret, are a person's to attach);
 * - grants and rules that name only `dispatch-task`, never `isolated-repair`
 *   or `publish-branch`, which no agent can do itself;
 * - a rule that never pins `auto` approval (an agent cannot loosen its own
 *   approvals, so it cannot ask for a rule that would);
 * - only Project/Agent pairs the proposing chat could dispatch work to now
 *   ({@link AutomationProposalAuthority});
 * - nothing that carries `fullAccessGrant`, `enabled`, `mode` or a
 *   credential: confirmation decides whether it starts enabled.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  AUTOMATION_ACTION_KINDS,
  AUTOMATION_EXECUTION_LIMITS,
  AUTOMATION_PROPOSAL_LIMITS,
  AUTOMATION_PROPOSAL_UNTRUSTED_COPY,
  type AutomationConfiguration,
  type AutomationMatcher,
  type AutomationProposal,
  type AutomationProposalDescription,
  type AutomationProposalRefusalCode,
  type AutomationProposalState,
  type AutomationRule,
  type AutomationRuleProposalInput,
  type AutomationSource,
  type AutomationSourceProposalInput,
} from '@kontourai/station-contracts/automation';
import { z } from 'zod';
import type { StationControlPolicyCaller } from '../../tools/station-control-policy.js';
import { isRecord } from '../../utils/is-record.js';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from '../orchestration/delegation-result-delivery.js';
import {
  type CurrentTurnStartReader,
  isCurrentTurnPersonAuthored,
} from '../orchestration/turn-authorship.js';
import { automationConfigurationProblems } from './automation-config-validation.js';

const RATE_WINDOW_MS = 60 * 60 * 1000;
const PLACEHOLDER_SOURCE_ID = 'proposed-source';
const PLACEHOLDER_RULE_ID = 'proposed-rule';

/**
 * Keys that carry authority a person grants at confirmation or never. Any of
 * them, anywhere in a proposal body, is an escalation and is refused as one.
 */
const AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  'fullAccessGrant',
  'credentialSecretBinding',
  'secret',
  'enabled',
  'mode',
  'revokedAt',
]);

// ── what an agent may send ────────────────────────────────────────────────

const boundedId = z
  .string()
  .min(1)
  .max(AUTOMATION_EXECUTION_LIMITS.maxIdLength);
const name = z.string().min(1).max(AUTOMATION_EXECUTION_LIMITS.maxNameLength);
const rationale = z
  .string()
  .min(1)
  .max(AUTOMATION_PROPOSAL_LIMITS.maxRationaleLength)
  .optional();

const grantSchema = z
  .object({
    projectId: boundedId,
    agentId: boundedId,
    // Parsed wide so a grant naming a kind an agent cannot do is refused as
    // an escalation, not as a typo.
    actions: z.array(z.enum(AUTOMATION_ACTION_KINDS)).min(1),
  })
  .strict();

const sourceBodySchema = z
  .object({
    kind: z.string(),
    name,
    repository: z.string().min(1),
    pollIntervalMs: z.number().int().optional(),
    grants: z.array(grantSchema).optional(),
    rationale,
  })
  .strict();

const matcherSchema = z
  .object({
    type: z.string(),
    where: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  })
  .strict();

const dispatchActionSchema = z
  .object({
    kind: z.literal('dispatch-task'),
    projectId: boundedId,
    agentId: boundedId,
    instructions: z.string().min(1),
    approvalMode: z.enum(['ask', 'auto']).optional(),
    budget: z
      .object({
        maxTurns: z.number().int(),
        maxTokens: z.number().int(),
        maxWallRuntimeMs: z.number().int(),
      })
      .strict(),
  })
  .strict();

const ruleBodySchema = z
  .object({
    name,
    sourceId: boundedId.optional(),
    sourceProposalId: boundedId.optional(),
    match: matcherSchema,
    episode: z
      .object({
        keyFields: z.array(z.string()),
        closeOn: matcherSchema.optional(),
        maxAttempts: z.number().int(),
      })
      .strict()
      .optional(),
    action: z.object({ kind: z.string() }).passthrough(),
    rateLimit: z.object({ maxStartsPerHour: z.number().int() }).strict(),
    rationale,
  })
  .strict();

// ── authority ─────────────────────────────────────────────────────────────

/**
 * One Project/Agent pair a proposal names, as Station resolved it when the
 * chat proposed it. Agents have no identity beyond their slug, so the Agent
 * is pinned by its slug, its own Project and a digest of its whole
 * definition: a deleted Agent, one moved to another Project, or a slug
 * reused for a different definition no longer matches (#4830 review).
 */
export type AutomationTargetBinding = Readonly<{
  projectId: string;
  projectSlug: string;
  agentId: string;
  /** The Agent's own Project slug; `null` for a global Agent. */
  agentProject: string | null;
  agentDigest: string;
}>;

/** What the proposing chat may do itself, decided by the dispatch scope rule. */
export interface AutomationProposalAuthority {
  /**
   * The pair resolved, when the proposing chat could dispatch work to
   * `agentId` in `projectId` itself; `undefined` when it could not or Station
   * cannot read it.
   */
  bind(
    projectId: string,
    agentId: string,
  ): Promise<AutomationTargetBinding | undefined>;
}

/** Whether a binding resolved now is the one recorded at proposal time. */
export function sameAutomationTargetBinding(
  recorded: AutomationTargetBinding,
  current: AutomationTargetBinding | undefined,
): boolean {
  return (
    current !== undefined &&
    current.projectId === recorded.projectId &&
    current.projectSlug === recorded.projectSlug &&
    current.agentId === recorded.agentId &&
    current.agentProject === recorded.agentProject &&
    current.agentDigest === recorded.agentDigest
  );
}

/** A stable digest of an Agent's definition: object keys sorted, arrays kept. */
export function agentDefinitionDigest(definition: unknown): string {
  return createHash('sha256').update(stableJson(definition)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

export interface AutomationProposalPlanContext {
  readonly conversationId: string;
  readonly authority: AutomationProposalAuthority;
  /** The current configuration; throws when it is unreadable. */
  configuration(): AutomationConfiguration;
  /** A proposal by id, for a rule that names a source proposal. */
  proposal(id: string): AutomationProposal | undefined;
  /** A Project's display name; falls back to its id. */
  projectName?(projectId: string): string | undefined;
  /** The proposing chat had read untrusted content (#3483). */
  readonly untrusted: boolean;
}

export type AutomationProposalPlan =
  | Readonly<{
      ok: true;
      kind: 'source';
      source: AutomationSourceProposalInput;
      description: AutomationProposalDescription;
      bindings: readonly AutomationTargetBinding[];
      rationale?: string;
    }>
  | Readonly<{
      ok: true;
      kind: 'rule';
      rule: AutomationRuleProposalInput;
      description: AutomationProposalDescription;
      bindings: readonly AutomationTargetBinding[];
      rationale?: string;
    }>
  | Readonly<{
      ok: false;
      code: AutomationProposalRefusalCode;
      error: string;
      problems?: readonly string[];
    }>;

const refuse = (
  code: AutomationProposalRefusalCode,
  error: string,
  problems?: readonly string[],
): AutomationProposalPlan => ({
  ok: false,
  code,
  error,
  ...(problems && problems.length > 0 ? { problems } : {}),
});

/** The first authority-bearing key anywhere in `value`, if any. */
function authorityKeyIn(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = authorityKeyIn(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, inner] of Object.entries(value)) {
    if (AUTHORITY_KEYS.has(key)) return key;
    const found = authorityKeyIn(inner, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function escalationRefusal(key: string): AutomationProposalPlan {
  return refuse(
    'automation_proposal_exceeds_authority',
    key === 'fullAccessGrant'
      ? 'An automation never runs with full access, and an agent cannot ask for it.'
      : `\`${key}\` is the person's choice, not the agent's: leave it out. The person decides when they confirm.`,
  );
}

/** Each pair resolved, or the pairs this chat could not dispatch to itself. */
async function bindPairs(
  authority: AutomationProposalAuthority,
  pairs: readonly { projectId: string; agentId: string }[],
): Promise<
  | { ok: true; bindings: AutomationTargetBinding[] }
  | { ok: false; outside: string[] }
> {
  const bindings: AutomationTargetBinding[] = [];
  const outside: string[] = [];
  for (const { projectId, agentId } of pairs) {
    let binding: AutomationTargetBinding | undefined;
    try {
      binding = await authority.bind(projectId, agentId);
    } catch {
      binding = undefined;
    }
    if (binding) bindings.push(binding);
    else outside.push(`${agentId} in ${projectId}`);
  }
  return outside.length > 0 ? { ok: false, outside } : { ok: true, bindings };
}

function currentConfiguration(
  context: AutomationProposalPlanContext,
): AutomationConfiguration | undefined {
  try {
    return context.configuration();
  } catch {
    return undefined;
  }
}

/** Validates a source proposal and renders its description. */
export async function planSourceProposal(
  body: unknown,
  context: AutomationProposalPlanContext,
): Promise<AutomationProposalPlan> {
  const key = authorityKeyIn(body);
  if (key) return escalationRefusal(key);
  const parsed = sourceBodySchema.safeParse(body);
  if (!parsed.success)
    return refuse(
      'automation_proposal_invalid',
      'propose_automation_source needs kind "github-poll", a name, and a repository as owner/repo; grants and pollIntervalMs are optional.',
    );
  const { rationale: why, ...input } = parsed.data;
  if (input.kind !== 'github-poll')
    return refuse(
      'automation_proposal_invalid',
      'Only a github-poll source can be proposed. A webhook source needs a secret only a person may hold.',
    );
  const grants = input.grants ?? [];
  if (grants.some((grant) => grant.actions.some((a) => a !== 'dispatch-task')))
    return refuse(
      'automation_proposal_exceeds_authority',
      'A proposed source may grant only dispatch-task. Isolated repair, publishing and notifications are set up by a person.',
    );
  const bound = await bindPairs(context.authority, grants);
  if (!bound.ok)
    return refuse(
      'automation_proposal_exceeds_authority',
      `This chat could not start work for ${bound.outside.join(', ')} itself, so it cannot propose a source that grants it.`,
    );
  const source: AutomationSourceProposalInput = {
    kind: 'github-poll',
    name: input.name,
    repository: input.repository,
    ...(input.pollIntervalMs !== undefined
      ? { pollIntervalMs: input.pollIntervalMs }
      : {}),
    ...(input.grants ? { grants: input.grants } : {}),
  };
  const configuration = currentConfiguration(context);
  if (!configuration)
    return refuse(
      'automation_proposal_unavailable',
      'Automation configuration is unavailable on this Station.',
    );
  const problems = automationConfigurationProblems({
    ...configuration,
    sources: [
      ...configuration.sources,
      { ...source, id: PLACEHOLDER_SOURCE_ID, enabled: false },
    ],
  });
  if (problems.length > 0)
    return refuse(
      'automation_proposal_invalid',
      'That source is not one Station would create.',
      problems,
    );
  return {
    ok: true,
    kind: 'source',
    source,
    description: describeSourceProposal(source, context),
    bindings: bound.bindings,
    ...(why ? { rationale: why } : {}),
  };
}

/** Validates a rule proposal and renders its description. */
export async function planRuleProposal(
  body: unknown,
  context: AutomationProposalPlanContext,
): Promise<AutomationProposalPlan> {
  const key = authorityKeyIn(body);
  if (key) return escalationRefusal(key);
  const parsed = ruleBodySchema.safeParse(body);
  if (!parsed.success)
    return refuse(
      'automation_proposal_invalid',
      'propose_automation_rule needs a name, one of sourceId or sourceProposalId, match, action, and rateLimit.',
    );
  const { rationale: why, ...input } = parsed.data;
  if ((input.sourceId === undefined) === (input.sourceProposalId === undefined))
    return refuse(
      'automation_proposal_invalid',
      'Name exactly one of sourceId (an existing source) or sourceProposalId (a source this chat proposed).',
    );
  if (input.action.kind !== 'dispatch-task')
    return refuse(
      'automation_proposal_exceeds_authority',
      'A proposed rule may only start a Task (dispatch-task). Isolated repair and publishing are set up by a person.',
    );
  const action = dispatchActionSchema.safeParse(input.action);
  if (!action.success)
    return refuse(
      'automation_proposal_invalid',
      'A dispatch-task action needs projectId, agentId, instructions and a budget (maxTurns, maxTokens, maxWallRuntimeMs).',
    );
  if (action.data.approvalMode === 'auto')
    return refuse(
      'automation_proposal_exceeds_authority',
      'An agent cannot propose a rule that approves its own tool calls. Leave approvalMode out (it runs as ask).',
    );
  const bound = await bindPairs(context.authority, [action.data]);
  if (!bound.ok)
    return refuse(
      'automation_proposal_exceeds_authority',
      `This chat could not start work for ${bound.outside.join(', ')} itself, so it cannot propose a rule that would.`,
    );
  const configuration = currentConfiguration(context);
  if (!configuration)
    return refuse(
      'automation_proposal_unavailable',
      'Automation configuration is unavailable on this Station.',
    );

  // The source the rule would attach to: an existing one, or the proposed
  // source as it would be created (a confirmed proposal is its created source).
  let sourceId = input.sourceId;
  let sourceProposalId = input.sourceProposalId;
  let candidateSource: AutomationSource | undefined;
  if (sourceProposalId !== undefined) {
    const proposed = context.proposal(sourceProposalId);
    if (
      !proposed ||
      proposed.kind !== 'source' ||
      proposed.conversationId !== context.conversationId ||
      proposed.state === 'declined'
    )
      return refuse(
        'automation_proposal_invalid',
        'sourceProposalId must name an open or confirmed source proposal from this chat.',
      );
    if (proposed.state === 'confirmed' && proposed.createdId) {
      sourceId = proposed.createdId;
      sourceProposalId = undefined;
    } else {
      candidateSource = {
        ...proposed.source,
        id: PLACEHOLDER_SOURCE_ID,
        enabled: false,
      };
    }
  }
  const rule: AutomationRuleProposalInput = {
    name: input.name,
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(sourceProposalId !== undefined ? { sourceProposalId } : {}),
    match: input.match as AutomationMatcher,
    ...(input.episode
      ? { episode: input.episode as AutomationRuleProposalInput['episode'] }
      : {}),
    action: {
      kind: 'dispatch-task',
      projectId: action.data.projectId,
      agentId: action.data.agentId,
      instructions: action.data.instructions,
      ...(action.data.approvalMode ? { approvalMode: 'ask' as const } : {}),
      budget: action.data.budget,
    },
    rateLimit: input.rateLimit,
  };
  const candidateRule = {
    id: PLACEHOLDER_RULE_ID,
    name: rule.name,
    mode: 'observe',
    sourceId: sourceId ?? PLACEHOLDER_SOURCE_ID,
    match: rule.match,
    ...(rule.episode ? { episode: rule.episode } : {}),
    action: rule.action,
    rateLimit: rule.rateLimit,
  } satisfies AutomationRule;
  const problems = automationConfigurationProblems({
    ...configuration,
    sources: candidateSource
      ? [...configuration.sources, candidateSource]
      : configuration.sources,
    rules: [...configuration.rules, candidateRule],
  });
  if (problems.length > 0)
    return refuse(
      'automation_proposal_invalid',
      'That rule is not one Station would create.',
      problems,
    );
  const source =
    candidateSource ??
    configuration.sources.find((candidate) => candidate.id === sourceId);
  return {
    ok: true,
    kind: 'rule',
    rule,
    description: describeRuleProposal(
      rule,
      source
        ? {
            repository: source.repository,
            pending: candidateSource !== undefined,
          }
        : undefined,
      context,
    ),
    bindings: bound.bindings,
    ...(why ? { rationale: why } : {}),
  };
}

// ── the description a person confirms ─────────────────────────────────────
//
// Every sentence here is Station's. Nothing the agent wrote (a name, a
// matcher value, instructions, a reason) is put inside one: the card shows
// those apart, labelled as the agent's, and whole (#4830 review). Only values
// Station validated against its own records appear: the repository
// (`owner/repo` of a fixed character set), the Agent slug and the Project.

export { AUTOMATION_PROPOSAL_UNTRUSTED_COPY };

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000);
  return `${value} minute${value === 1 ? '' : 's'}`;
}

function hours(ms: number): string {
  const value = ms / 3_600_000;
  return value >= 1
    ? `${Number(value.toFixed(1))} hour${value === 1 ? '' : 's'}`
    : minutes(ms);
}

function projectLabel(
  context: Pick<AutomationProposalPlanContext, 'projectName'>,
  projectId: string,
): string {
  let label: string | undefined;
  try {
    label = context.projectName?.(projectId);
  } catch {
    label = undefined;
  }
  return label ? `${label} (${projectId})` : projectId;
}

function untrustedPart(
  context: Pick<AutomationProposalPlanContext, 'untrusted'>,
): { untrusted?: string } {
  return context.untrusted
    ? { untrusted: AUTOMATION_PROPOSAL_UNTRUSTED_COPY }
    : {};
}

function describeSourceProposal(
  source: AutomationSourceProposalInput,
  context: Pick<AutomationProposalPlanContext, 'projectName' | 'untrusted'>,
): AutomationProposalDescription {
  const interval =
    source.pollIntervalMs ?? AUTOMATION_EXECUTION_LIMITS.defaultPollIntervalMs;
  const grants = source.grants ?? [];
  const pairs = grants.map(
    (grant) =>
      `Agent ${grant.agentId} in ${projectLabel(context, grant.projectId)}`,
  );
  return {
    title: `Watch ${source.repository} on GitHub`,
    watches: `Completed GitHub Actions workflow runs in ${source.repository}, checked every ${minutes(interval)} with no stored credential.`,
    opens:
      pairs.length > 0
        ? 'Nothing by itself. Rules you add to this source may open Tasks for the agents below.'
        : 'Nothing. It grants no rule an action, so it can only record what it sees.',
    wakes: pairs.length > 0 ? pairs.join('; ') : 'No agent.',
    authority:
      'It may let rules start a bounded Task (dispatch-task) and nothing else: never full access, isolated repair, publishing or merging.',
    startsAs: 'Created disabled: it polls nothing until it is enabled.',
    ifEnabled:
      'Enabled now: Station polls it while GitHub automation observations are on in Feature previews. Its rules act only once they are live.',
    ...untrustedPart(context),
  };
}

function describeRuleProposal(
  rule: AutomationRuleProposalInput,
  source: { repository: string; pending: boolean } | undefined,
  context: Pick<AutomationProposalPlanContext, 'projectName' | 'untrusted'>,
): AutomationProposalDescription {
  const { action } = rule;
  const from = source
    ? `in ${source.repository}, from ${source.pending ? 'the source proposed in this chat, once you confirm it' : 'an existing source'}`
    : 'from its source';
  const episode = rule.episode
    ? ` Matching runs that share ${rule.episode.keyFields.length} key field${rule.episode.keyFields.length === 1 ? '' : 's'} are one episode: at most ${rule.episode.maxAttempts} attempt${rule.episode.maxAttempts === 1 ? '' : 's'} until ${rule.episode.closeOn ? 'a run matches its close conditions' : 'a person retries it'}.`
    : '';
  return {
    title: 'Open a Task when a matching GitHub run arrives',
    watches: `Completed GitHub Actions runs ${from}, when every condition the agent wrote below matches.`,
    opens: `A Task in ${projectLabel(context, action.projectId)} for a matching run, at most ${rule.rateLimit.maxStartsPerHour} per hour.${episode}`,
    wakes: `Agent ${action.agentId} in ${projectLabel(context, action.projectId)}, with the agent's instructions below.`,
    authority: `Asks before each tool call (approval mode ask) and never has full access. Each run is limited to ${action.budget.maxTurns} turns, ${action.budget.maxTokens.toLocaleString('en-US')} tokens and ${hours(action.budget.maxWallRuntimeMs)}. It cannot merge, publish, or change automations or grants.`,
    startsAs:
      'Created observing: it records what it would have done for each matching run but never starts a Task.',
    ifEnabled:
      'Live now: matching runs open Tasks once its source is enabled and GitHub automation Tasks are on in Feature previews.',
    ...untrustedPart(context),
  };
}

// ── who may propose ───────────────────────────────────────────────────────

/**
 * The turn a station-control call is inferred to be made in
 * (`stationControlCallingTurn`). Inferred from Session state, not known:
 * the call carries no turn identity until #4882.
 */
export type StationControlCallingTurn =
  | { readonly kind: 'turn'; readonly turnId: string }
  | { readonly kind: 'pending' | 'none' };

export interface AutomationProposerReads {
  /** The inferred calling turn: the Session's running turn, or why not. */
  callingTurn(sessionId: string): StationControlCallingTurn;
  /** The store read #4827's predicate needs. */
  readonly store: CurrentTurnStartReader;
}

/**
 * The inferred calling turn's id when that turn may propose automations,
 * else `undefined`. Only a turn a person typed into one of Station's own
 * clients qualifies, by the shared server-stamped mark (#4827), read from
 * that turn's own `turn.started`, never a steer (#4830 re-reviews).
 *
 * The calling turn is INFERRED from Session state, not known: a
 * station-control call carries no turn identity. A turn-bound credential is
 * the fix (#4882). Known gaps of the inference: a concurrent steer, failed or
 * accepted, clears an in-flight delegated continuation's pending
 * reservation, so that continuation's call can be judged by the person's
 * earlier turn and create a proposal card; and an invocationless legacy
 * start can leave the Session stuck `pending`, wrongly refusing until it
 * exits. A person's in-person confirmation stays the authority boundary.
 *
 * - the calling turn is taken to be the one the Session is running; a call
 *   while a send's start is not yet stored (`pending`), or with no running
 *   turn (`none`), refuses, so a delegated continuation whose start is held
 *   for acceptance is not judged by the person turn before it (except in the
 *   steer race above);
 * - the stored newest own start must be that running turn and carry the
 *   mark; anything else, and anything Station cannot read, refuses.
 *
 * So an automation's run, a delegated result, a `/chat/delegated` peer, a
 * background run, the CLI, MCP, a Task dispatch, a check-back and any turn
 * recorded before the mark all refuse. A Session that acts for no one (an
 * automation-rule Task's, a webhook's) is refused before this by its
 * missing recorded owner. The route asks again inside the transaction that
 * stores the proposal and requires the same turn.
 */
export function proposingTurnId(
  reads: AutomationProposerReads,
  sessionId: string,
): string | undefined {
  try {
    const calling = reads.callingTurn(sessionId);
    if (calling.kind !== 'turn') return undefined;
    const started = reads.store.latestOwnTurnStarted(sessionId);
    if (
      !started ||
      started.payload.turnId !== calling.turnId ||
      !isCurrentTurnPersonAuthored(reads.store, sessionId)
    )
      return undefined;
    return calling.turnId;
  } catch {
    return undefined;
  }
}

/**
 * The id a confirmed proposal's source or rule is created under, derived
 * from the proposal: one proposal can name only one object, so a Confirm
 * retried after a restart finds what an interrupted one created instead of
 * creating a second (#4830 review). UUID-shaped (version 8, custom) so the
 * operator API, which takes UUIDs, can address it.
 */
export function automationIdForProposal(proposalId: string): string {
  const hex = createHash('sha256')
    .update(`station-automation-proposal:${proposalId}`)
    .digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ── records ───────────────────────────────────────────────────────────────

const AUTOMATION_PROPOSAL_SCHEMA = `CREATE TABLE IF NOT EXISTS automation_proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_json TEXT NOT NULL,
  description_json TEXT NOT NULL,
  untrusted INTEGER NOT NULL,
  proposer_json TEXT NOT NULL,
  bindings_json TEXT NOT NULL,
  untrusted_at_confirm INTEGER,
  rationale TEXT,
  state TEXT NOT NULL,
  settled_by TEXT,
  created_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS automation_proposals_conversation
  ON automation_proposals (conversation_id, state);
CREATE INDEX IF NOT EXISTS automation_proposals_created
  ON automation_proposals (conversation_id, created_at)`;

/**
 * States still waiting for a person. `confirming` is a Confirm in flight (the
 * source or rule is being created); it reads as `open`.
 */
const OPEN_STATES = "('open', 'confirming')";

export type AutomationProposalStoredState =
  | AutomationProposalState
  | 'confirming';

/**
 * The verified station-control caller that proposed it, as the scope rule
 * reads a caller. Confirm decides the scope again for this caller, now.
 */
export type AutomationProposer = StationControlPolicyCaller &
  Readonly<{ sessionId: string; conversationId: string }>;

export type AutomationProposalAuthorityRecord = Readonly<{
  proposer: AutomationProposer;
  bindings: readonly AutomationTargetBinding[];
}>;

export type InsertAutomationProposalResult =
  | { readonly outcome: 'proposed'; readonly proposal: AutomationProposal }
  | { readonly outcome: 'limit-reached' }
  | { readonly outcome: 'rate-limited' }
  | { readonly outcome: 'not-admitted' };

const iso = (ms: number) => new Date(ms).toISOString();

function proposalOf(row: Record<string, unknown>): AutomationProposal {
  const state = String(row.state);
  const base = {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    description: JSON.parse(
      String(row.description_json),
    ) as AutomationProposalDescription,
    untrustedContent: Number(row.untrusted) === 1,
    ...(typeof row.rationale === 'string' ? { rationale: row.rationale } : {}),
    state: (state === 'confirming' ? 'open' : state) as AutomationProposalState,
    ...(typeof row.created_id === 'string'
      ? { createdId: row.created_id }
      : {}),
    ...(row.untrusted_at_confirm === null ||
    row.untrusted_at_confirm === undefined
      ? {}
      : { untrustedContentAtConfirm: Number(row.untrusted_at_confirm) === 1 }),
    createdAt: iso(Number(row.created_at)),
    updatedAt: iso(Number(row.updated_at)),
  };
  const input = JSON.parse(String(row.input_json)) as unknown;
  return row.kind === 'source'
    ? {
        ...base,
        kind: 'source',
        source: input as AutomationSourceProposalInput,
      }
    : { ...base, kind: 'rule', rule: input as AutomationRuleProposalInput };
}

const ASSURANCES = new Set(['bound', 'delegated-custody', 'bearer-exposed']);

/** A stored proposer, or `undefined` when it is not one (which refuses). */
function parseProposer(value: unknown): AutomationProposer | undefined {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== 'string' ||
    typeof value.conversationId !== 'string' ||
    typeof value.assurance !== 'string' ||
    !ASSURANCES.has(value.assurance)
  )
    return undefined;
  const principal = value.principal;
  if (
    principal !== undefined &&
    (!isRecord(principal) ||
      typeof principal.id !== 'string' ||
      typeof principal.elevationEligible !== 'boolean')
  )
    return undefined;
  const optionalString = (key: string) =>
    value[key] === undefined || typeof value[key] === 'string';
  if (
    !optionalString('localProjectId') ||
    !optionalString('projectSlug') ||
    !(
      value.projectIdSource === undefined ||
      value.projectIdSource === 'session-record' ||
      value.projectIdSource === 'slug-lookup'
    )
  )
    return undefined;
  return {
    assurance: value.assurance as AutomationProposer['assurance'],
    sessionId: value.sessionId,
    conversationId: value.conversationId,
    ...(isRecord(principal)
      ? {
          principal: {
            id: principal.id as string,
            elevationEligible: principal.elevationEligible as boolean,
          },
        }
      : {}),
    ...(typeof value.localProjectId === 'string'
      ? { localProjectId: value.localProjectId }
      : {}),
    ...(value.projectIdSource === 'session-record' ||
    value.projectIdSource === 'slug-lookup'
      ? { projectIdSource: value.projectIdSource }
      : {}),
    ...(typeof value.projectSlug === 'string'
      ? { projectSlug: value.projectSlug }
      : {}),
  };
}

function isTargetBinding(value: unknown): value is AutomationTargetBinding {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.projectSlug === 'string' &&
    typeof value.agentId === 'string' &&
    (value.agentProject === null || typeof value.agentProject === 'string') &&
    typeof value.agentDigest === 'string'
  );
}

/** The durable proposals; every transition is one conditional UPDATE. */
export function createSqliteAutomationProposalStore(
  db: TransactionalSqliteDatabase,
) {
  db.exec(AUTOMATION_PROPOSAL_SCHEMA);
  const read = (id: string): AutomationProposal | undefined => {
    const row = db
      .prepare('SELECT * FROM automation_proposals WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? proposalOf(row) : undefined;
  };
  return {
    insert(input: {
      conversationId: string;
      sessionId: string;
      plan: Extract<AutomationProposalPlan, { ok: true }>;
      /** The verified caller that proposed it, rechecked at Confirm. */
      proposer: AutomationProposer;
      untrusted: boolean;
      now: number;
      /**
       * Decided again inside this write transaction: false refuses, so a
       * turn change between the route's check and this write stores nothing.
       */
      admit?: () => boolean;
    }): InsertAutomationProposalResult {
      return writeTransaction(db, 'automation_proposal_insert', () => {
        if (input.admit && !input.admit())
          return { outcome: 'not-admitted' as const };
        db.prepare(
          `DELETE FROM automation_proposals WHERE state = 'declined' AND updated_at <= ?`,
        ).run(input.now - RATE_WINDOW_MS);
        const open = db
          .prepare(
            `SELECT id FROM automation_proposals WHERE conversation_id = ? AND state IN ${OPEN_STATES} LIMIT ?`,
          )
          .all(
            input.conversationId,
            AUTOMATION_PROPOSAL_LIMITS.maxOpenPerConversation + 1,
          );
        if (open.length >= AUTOMATION_PROPOSAL_LIMITS.maxOpenPerConversation)
          return { outcome: 'limit-reached' as const };
        const recent = db
          .prepare(
            'SELECT id FROM automation_proposals WHERE conversation_id = ? AND created_at > ? LIMIT ?',
          )
          .all(
            input.conversationId,
            input.now - RATE_WINDOW_MS,
            AUTOMATION_PROPOSAL_LIMITS.maxCreatedPerHour + 1,
          );
        if (recent.length >= AUTOMATION_PROPOSAL_LIMITS.maxCreatedPerHour)
          return { outcome: 'rate-limited' as const };
        const id = randomUUID();
        const { plan } = input;
        db.prepare(
          `INSERT INTO automation_proposals (id, conversation_id, session_id,
             kind, input_json, description_json, untrusted, proposer_json,
             bindings_json, rationale, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(
          id,
          input.conversationId,
          input.sessionId,
          plan.kind,
          JSON.stringify(plan.kind === 'source' ? plan.source : plan.rule),
          JSON.stringify(plan.description),
          input.untrusted ? 1 : 0,
          JSON.stringify(input.proposer),
          JSON.stringify(plan.bindings),
          plan.rationale ?? null,
          input.now,
          input.now,
        );
        return { outcome: 'proposed' as const, proposal: read(id)! };
      });
    },
    proposal: read,
    /**
     * Who proposed it and what it was bound to, for Confirm to recheck;
     * `undefined` for an unknown proposal or one Station cannot read, which
     * refuses.
     */
    authority(id: string): AutomationProposalAuthorityRecord | undefined {
      const row = db
        .prepare(
          'SELECT proposer_json, bindings_json FROM automation_proposals WHERE id = ?',
        )
        .get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      try {
        const proposer = parseProposer(JSON.parse(String(row.proposer_json)));
        const bindings = JSON.parse(String(row.bindings_json)) as unknown;
        if (
          !proposer ||
          !Array.isArray(bindings) ||
          !bindings.every(isTargetBinding)
        )
          return undefined;
        return { proposer, bindings };
      } catch {
        return undefined;
      }
    },
    /** Proposals still waiting for a person, oldest first. */
    openProposals(conversationId: string): AutomationProposal[] {
      return (
        db
          .prepare(
            `SELECT * FROM automation_proposals WHERE conversation_id = ? AND state IN ${OPEN_STATES} ORDER BY created_at`,
          )
          .all(conversationId) as Record<string, unknown>[]
      ).map(proposalOf);
    },
    /** This conversation's proposals in any state, newest first, bounded. */
    recentProposals(
      conversationId: string,
      limit: number,
    ): AutomationProposal[] {
      return (
        db
          .prepare(
            'SELECT * FROM automation_proposals WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(conversationId, limit) as Record<string, unknown>[]
      ).map(proposalOf);
    },
    /**
     * Move a proposal `from` one state `to` another; false when it is no
     * longer in `from`. Confirm claims (`open` -> `confirming`) before it
     * creates anything and then finalizes (`confirming` -> `confirmed`, with
     * the created id) or reverts (`confirming` -> `open`). Decline is
     * `open` -> `declined`, so a Decline racing a claimed Confirm changes
     * nothing.
     */
    transition(
      id: string,
      from: 'open' | 'confirming',
      to: AutomationProposalStoredState,
      settledBy: string | null,
      now: number,
      settled?: { createdId?: string; untrustedAtConfirm?: boolean },
    ): boolean {
      const untrustedAtConfirm =
        settled?.untrustedAtConfirm === undefined
          ? null
          : settled.untrustedAtConfirm
            ? 1
            : 0;
      const result = db
        .prepare(
          `UPDATE automation_proposals SET state = ?, settled_by = ?, updated_at = ?,
             created_id = COALESCE(?, created_id),
             untrusted_at_confirm = COALESCE(?, untrusted_at_confirm)
           WHERE id = ? AND state = ?`,
        )
        .run(
          to,
          settledBy,
          now,
          settled?.createdId ?? null,
          untrustedAtConfirm,
          id,
          from,
        ) as { changes?: number | bigint };
      return Number(result.changes ?? 0) === 1;
    },
    /** The raw state, `confirming` included. */
    storedState(id: string): AutomationProposalStoredState | undefined {
      const row = db
        .prepare('SELECT state FROM automation_proposals WHERE id = ?')
        .get(id) as { state?: unknown } | undefined;
      return typeof row?.state === 'string'
        ? (row.state as AutomationProposalStoredState)
        : undefined;
    },
    /**
     * Startup: settle each Confirm a restart cut short (a claim made before
     * `claimedBefore`, this process's start). Its source or rule is created
     * under {@link automationIdForProposal}, so `exists` tells whether it got
     * that far: if so the proposal is `confirmed` with that id (keeping who
     * confirmed it); if not it is `open` again for a person to retry. Either
     * way a retry never creates a second copy. An object created but not yet
     * enabled stays in its default-deny state.
     */
    reconcileInterrupted(
      claimedBefore: number,
      now: number,
      exists: (createdId: string) => boolean,
    ): { confirmed: number; reopened: number } {
      const rows = db
        .prepare(
          `SELECT id FROM automation_proposals WHERE state = 'confirming' AND updated_at < ?`,
        )
        .all(claimedBefore) as { id: string }[];
      let confirmed = 0;
      let reopened = 0;
      for (const { id } of rows) {
        const createdId = automationIdForProposal(id);
        if (exists(createdId)) {
          const result = db
            .prepare(
              `UPDATE automation_proposals SET state = 'confirmed', created_id = ?, updated_at = ?
               WHERE id = ? AND state = 'confirming'`,
            )
            .run(createdId, now, id) as { changes?: number | bigint };
          if (Number(result.changes ?? 0) === 1) confirmed += 1;
        } else {
          const result = db
            .prepare(
              `UPDATE automation_proposals SET state = 'open', settled_by = NULL, updated_at = ?
               WHERE id = ? AND state = 'confirming'`,
            )
            .run(now, id) as { changes?: number | bigint };
          if (Number(result.changes ?? 0) === 1) reopened += 1;
        }
      }
      return { confirmed, reopened };
    },
  };
}

export type AutomationProposalStore = ReturnType<
  typeof createSqliteAutomationProposalStore
>;
