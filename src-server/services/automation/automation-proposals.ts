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

import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_ACTION_KINDS,
  AUTOMATION_EXECUTION_LIMITS,
  AUTOMATION_PROPOSAL_LIMITS,
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
import type { TurnDispatchOrigin } from '@kontourai/station-contracts/runtime-events';
import { z } from 'zod';
import { isRecord } from '../../utils/is-record.js';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from '../orchestration/delegation-result-delivery.js';
import type { EventStore } from '../orchestration/event-store.js';
import { readSessionDispatchFacts } from '../orchestration/session-dispatch-facts.js';
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

/** What the proposing chat may do itself, decided by the dispatch scope rule. */
export interface AutomationProposalAuthority {
  /**
   * Whether the proposing chat could dispatch work to `agentId` in
   * `projectId` itself. Anything Station cannot read answers false.
   */
  mayDispatch(projectId: string, agentId: string): Promise<boolean>;
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
      rationale?: string;
    }>
  | Readonly<{
      ok: true;
      kind: 'rule';
      rule: AutomationRuleProposalInput;
      description: AutomationProposalDescription;
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

async function pairsOutsideAuthority(
  authority: AutomationProposalAuthority,
  pairs: readonly { projectId: string; agentId: string }[],
): Promise<string[]> {
  const refused: string[] = [];
  for (const { projectId, agentId } of pairs) {
    let allowed = false;
    try {
      allowed = await authority.mayDispatch(projectId, agentId);
    } catch {
      allowed = false;
    }
    if (!allowed) refused.push(`${agentId} in ${projectId}`);
  }
  return refused;
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
  const outside = await pairsOutsideAuthority(context.authority, grants);
  if (outside.length > 0)
    return refuse(
      'automation_proposal_exceeds_authority',
      `This chat could not start work for ${outside.join(', ')} itself, so it cannot propose a source that grants it.`,
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
  const outside = await pairsOutsideAuthority(context.authority, [action.data]);
  if (outside.length > 0)
    return refuse(
      'automation_proposal_exceeds_authority',
      `This chat could not start work for ${outside.join(', ')} itself, so it cannot propose a rule that would.`,
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
            name: source.name,
            repository: source.repository,
            pending: candidateSource !== undefined,
          }
        : undefined,
      context,
    ),
    ...(why ? { rationale: why } : {}),
  };
}

// ── the description a person confirms ─────────────────────────────────────

/** Fixed copy shown when the proposing chat had read untrusted content. */
export const AUTOMATION_PROPOSAL_UNTRUSTED_COPY =
  'This chat had read content written by others (such as email or web pages) before the agent proposed this. That content may have steered it: check it is what you asked for.';

const INSTRUCTIONS_PREVIEW_CHARS = 280;

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

function quoteValues(value: string | readonly string[]): string {
  const values = typeof value === 'string' ? [value] : value;
  return values.map((item) => `“${item}”`).join(' or ');
}

function matcherSentence(matcher: AutomationMatcher): string {
  const conditions = Object.entries(matcher.where).map(
    ([field, value]) => `${field} is ${quoteValues(value)}`,
  );
  return conditions.length > 0 ? conditions.join(' and ') : 'any value';
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

export function describeSourceProposal(
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
    title: `Watch ${source.repository} on GitHub (“${source.name}”)`,
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

export function describeRuleProposal(
  rule: AutomationRuleProposalInput,
  source: { name: string; repository: string; pending: boolean } | undefined,
  context: Pick<AutomationProposalPlanContext, 'projectName' | 'untrusted'>,
): AutomationProposalDescription {
  const { action } = rule;
  const from = source
    ? `${source.pending ? 'the proposed source' : 'source'} “${source.name}” (${source.repository})`
    : `source ${rule.sourceId ?? rule.sourceProposalId}`;
  const instructions =
    action.instructions.length > INSTRUCTIONS_PREVIEW_CHARS
      ? `${action.instructions.slice(0, INSTRUCTIONS_PREVIEW_CHARS)}…`
      : action.instructions;
  const episode = rule.episode
    ? ` Runs that share ${rule.episode.keyFields.join(', ')} are one episode: at most ${rule.episode.maxAttempts} attempt${rule.episode.maxAttempts === 1 ? '' : 's'} until ${rule.episode.closeOn ? matcherSentence(rule.episode.closeOn) : 'a person retries it'}.`
    : '';
  return {
    title: `Rule “${rule.name}”`,
    watches: `Completed GitHub Actions runs from ${from}${source?.pending ? ', once you confirm it' : ''}, where ${matcherSentence(rule.match)}.`,
    opens: `A Task in ${projectLabel(context, action.projectId)} for a matching run, at most ${rule.rateLimit.maxStartsPerHour} per hour.${episode}`,
    wakes: `Agent ${action.agentId}, with these instructions: “${instructions}”`,
    authority: `Asks before each tool call (approval mode ask) and never has full access. Each run is limited to ${action.budget.maxTurns} turns, ${action.budget.maxTokens.toLocaleString('en-US')} tokens and ${hours(action.budget.maxWallRuntimeMs)}. It cannot merge, publish, or change automations or grants.`,
    startsAs:
      'Created observing: it records what it would have done for each matching run but never starts a Task.',
    ifEnabled:
      'Live now: matching runs open Tasks once its source is enabled and GitHub automation Tasks are on in Feature previews.',
    ...untrustedPart(context),
  };
}

// ── who may propose ───────────────────────────────────────────────────────

export interface AutomationStartedReads {
  /**
   * The origin of the Session's current turn: its newest turn that was not a
   * delegated result (#4512 `readSessionDispatchFacts().priorOrigin`).
   */
  currentTurnOrigin(sessionId: string): TurnDispatchOrigin;
  /**
   * `createdBy` of the Task the Session runs for: `undefined` when it is not
   * bound to a Task, `null` when bound to one Station cannot read.
   */
  boundTaskCreatedBy(sessionId: string): string | null | undefined;
}

/**
 * The production reads over the orchestration event store and the Task
 * graph: the #4512 dispatch facts for the current turn, and the room
 * execution binding for the Task.
 */
export function automationStartedReads(
  eventStore: Pick<
    EventStore,
    | 'latestEventByMethod'
    | 'listEventsByMethods'
    | 'readProjectTaskRoomExecutionBinding'
  >,
  readTaskView: (
    taskId: string,
  ) => { readonly createdBy?: string } | null | undefined,
): AutomationStartedReads {
  return {
    currentTurnOrigin: (sessionId) =>
      readSessionDispatchFacts(eventStore, sessionId).priorOrigin(),
    boundTaskCreatedBy: (sessionId) => {
      const binding = eventStore.readProjectTaskRoomExecutionBinding(sessionId);
      if (!binding) return undefined;
      const task = readTaskView(binding.taskId);
      return task ? (task.createdBy ?? '') : null;
    },
  };
}

/**
 * Whether a Session's current work was started by an automation, so §5's
 * "never change automations" applies: it runs for an `automation-rule` Task,
 * or its current turn was sent by an automation (a rule's action or a
 * scheduled run) or delegated by unattended work. Anything Station cannot
 * read counts as started by an automation.
 */
export function sessionStartedByAutomation(
  reads: AutomationStartedReads,
  sessionId: string,
): boolean {
  try {
    const createdBy = reads.boundTaskCreatedBy(sessionId);
    if (createdBy === null || createdBy === 'automation-rule') return true;
    const origin = reads.currentTurnOrigin(sessionId);
    return origin === 'automation' || origin === 'delegation';
  } catch {
    return true;
  }
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

export type InsertAutomationProposalResult =
  | { readonly outcome: 'proposed'; readonly proposal: AutomationProposal }
  | { readonly outcome: 'limit-reached' }
  | { readonly outcome: 'rate-limited' };

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
      untrusted: boolean;
      now: number;
    }): InsertAutomationProposalResult {
      return writeTransaction(db, 'automation_proposal_insert', () => {
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
             kind, input_json, description_json, untrusted, rationale, state,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(
          id,
          input.conversationId,
          input.sessionId,
          plan.kind,
          JSON.stringify(plan.kind === 'source' ? plan.source : plan.rule),
          JSON.stringify(plan.description),
          input.untrusted ? 1 : 0,
          plan.rationale ?? null,
          input.now,
          input.now,
        );
        return { outcome: 'proposed' as const, proposal: read(id)! };
      });
    },
    proposal: read,
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
      createdId?: string,
    ): boolean {
      const result = db
        .prepare(
          `UPDATE automation_proposals SET state = ?, settled_by = ?, updated_at = ?,
             created_id = COALESCE(?, created_id)
           WHERE id = ? AND state = ?`,
        )
        .run(to, settledBy, now, createdId ?? null, id, from) as {
        changes?: number | bigint;
      };
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
     * Startup: a Confirm a restart cut short is open again, so a person can
     * retry it. Only claims made before `claimedBefore` (this process's
     * start). If the restart fell between creating the record and finalizing
     * the proposal, a retried Confirm creates it a second time (a known
     * limit: the configuration store has no idempotency key to match on).
     */
    reopenInterrupted(claimedBefore: number, now: number): number {
      const result = db
        .prepare(
          `UPDATE automation_proposals SET state = 'open', settled_by = NULL, updated_at = ?
           WHERE state = 'confirming' AND updated_at < ?`,
        )
        .run(now, claimedBefore) as { changes?: number | bigint };
      return Number(result.changes ?? 0);
    },
  };
}

export type AutomationProposalStore = ReturnType<
  typeof createSqliteAutomationProposalStore
>;
